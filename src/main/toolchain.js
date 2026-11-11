"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { paths } = require("./paths");

/**
 * Node.js majors the OpenContext runtime can actually run on.
 *
 * - @melandlabs/opencontext ≥ 0.13 bundles better-sqlite3 13, which declares
 *   `engines.node >= 22`; its prebuilt binary loads on Node 20 but the daemon
 *   dies with SIGSEGV as soon as it opens the database.
 * - Other runtime packages still depend on better-sqlite3 11, which only ships
 *   prebuilt binaries up to Node 23; on Node 24+ npm falls back to compiling
 *   it from source and the install fails on machines without a C++ toolchain.
 */
const MIN_NODE_MAJOR = 22;
const MAX_NODE_MAJOR = 23;
const isWindows = process.platform === "win32";

/** Runs a command and resolves with its exit code and captured output. */
function run(command, args, options = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, ...(options.env ?? {}) },
				shell: options.shell ?? false,
				windowsHide: true,
			});
		} catch (error) {
			resolve({ code: -1, stdout: "", stderr: error.message });
			return;
		}
		let stdout = "";
		let stderr = "";
		const limit = 200_000;
		child.stdout?.on("data", (chunk) => {
			stdout = (stdout + chunk.toString()).slice(-limit);
			options.onOutput?.(chunk.toString());
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-limit);
			options.onOutput?.(chunk.toString());
		});
		child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

function parseMajor(version) {
	const match = /v?(\d+)\./.exec(String(version ?? "").trim());
	return match ? Number(match[1]) : 0;
}

function isSupportedNode(version) {
	const major = parseMajor(version);
	return major >= MIN_NODE_MAJOR && major <= MAX_NODE_MAJOR;
}

/** Human-readable range for UI and logs, e.g. "22.x". */
const SUPPORTED_NODE_LABEL =
	MIN_NODE_MAJOR === MAX_NODE_MAJOR ? `${MIN_NODE_MAJOR}.x` : `${MIN_NODE_MAJOR}.x–${MAX_NODE_MAJOR}.x`;

/** Directory of the managed Node.js runtime, if one was unpacked. */
function managedRuntimeDir() {
	try {
		const entries = fs
			.readdirSync(paths.runtimeDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("node-v"))
			.map((entry) => path.join(paths.runtimeDir, entry.name));
		return entries.sort().pop() ?? null;
	} catch {
		return null;
	}
}

function managedNodePath() {
	const dir = managedRuntimeDir();
	if (!dir) return null;
	const binary = isWindows ? path.join(dir, "node.exe") : path.join(dir, "bin", "node");
	return fs.existsSync(binary) ? binary : null;
}

function managedNpmScript() {
	const dir = managedRuntimeDir();
	if (!dir) return null;
	const candidates = isWindows
		? [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
		: [path.join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function probeNode(binary) {
	const result = await run(binary, ["--version"]);
	if (result.code !== 0) return null;
	const version = result.stdout.trim();
	return isSupportedNode(version) ? version : { unsupported: version };
}

/** npm-cli.js shipped next to an absolute node binary, so node and npm match. */
function siblingNpmScript(nodeBinary) {
	if (!path.isAbsolute(nodeBinary)) return null;
	const dir = path.dirname(fs.realpathSync(nodeBinary));
	const candidates = isWindows
		? [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
		: [path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Resolves the node + npm pair used to install and run the daemon.
 * Prefers a managed runtime (deterministic version) and falls back to a
 * host Node.js within MIN_NODE_MAJOR..MAX_NODE_MAJOR. Anything outside that
 * range is skipped, so the installer downloads a managed Node.js instead.
 */
async function resolveToolchain() {
	const managedNode = managedNodePath();
	if (managedNode) {
		const version = await probeNode(managedNode);
		if (typeof version === "string") {
			return {
				ok: true,
				source: "managed",
				nodePath: managedNode,
				nodeVersion: version,
				npm: { kind: "script", script: managedNpmScript() },
			};
		}
	}

	const systemCandidates = [];
	if (process.env.OPENCONTEXT_NODE_PATH) systemCandidates.push(process.env.OPENCONTEXT_NODE_PATH);
	systemCandidates.push(isWindows ? "node.exe" : "node");
	if (!isWindows) systemCandidates.push("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node");

	for (const candidate of systemCandidates) {
		const version = await probeNode(candidate);
		if (typeof version !== "string") continue;
		let npmScript = null;
		try {
			npmScript = siblingNpmScript(candidate);
		} catch {
			npmScript = null;
		}
		if (npmScript) {
			return {
				ok: true,
				source: "system",
				nodePath: candidate,
				nodeVersion: version,
				npm: { kind: "script", script: npmScript },
			};
		}
		const npmProbe = await run(isWindows ? "npm.cmd" : "npm", ["--version"], { shell: isWindows });
		if (npmProbe.code !== 0) continue;
		return {
			ok: true,
			source: "system",
			nodePath: candidate,
			nodeVersion: version,
			npmVersion: npmProbe.stdout.trim(),
			npm: { kind: "command", command: isWindows ? "npm.cmd" : "npm", shell: isWindows },
		};
	}

	return { ok: false, source: null, nodePath: null, nodeVersion: null, npm: null };
}

/**
 * Environment that puts the resolved node binary first on PATH. npm runs
 * install scripts (prebuild-install, node-gyp) with whatever `node` is on PATH;
 * without this, native modules get fetched or compiled for the wrong Node.js
 * ABI when the host has a different version installed.
 */
function toolchainEnv(toolchain, base = process.env) {
	if (!toolchain?.nodePath || !path.isAbsolute(toolchain.nodePath)) return {};
	const key = Object.keys(base).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
	const current = base[key] ?? "";
	return { [key]: [path.dirname(toolchain.nodePath), current].filter(Boolean).join(path.delimiter) };
}

/** Spawns npm through whichever toolchain was resolved. */
function runNpm(toolchain, args, options = {}) {
	const env = { ...toolchainEnv(toolchain), ...(options.env ?? {}) };
	if (toolchain.npm?.kind === "script" && toolchain.npm.script) {
		return run(toolchain.nodePath, [toolchain.npm.script, ...args], { ...options, env });
	}
	if (toolchain.npm?.kind === "command") {
		return run(toolchain.npm.command, args, { ...options, env, shell: toolchain.npm.shell });
	}
	return Promise.resolve({ code: -1, stdout: "", stderr: "no npm available in the resolved toolchain" });
}

module.exports = {
	MIN_NODE_MAJOR,
	MAX_NODE_MAJOR,
	SUPPORTED_NODE_LABEL,
	isSupportedNode,
	isWindows,
	run,
	runNpm,
	toolchainEnv,
	parseMajor,
	probeNode,
	resolveToolchain,
	managedRuntimeDir,
	managedNodePath,
	platformLabel: () => `${process.platform}-${process.arch} (${os.release()})`,
};
