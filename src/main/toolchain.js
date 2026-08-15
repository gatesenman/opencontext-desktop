"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { paths } = require("./paths");

const MIN_NODE_MAJOR = 18;
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
	const match = /v?(\d+)\./.exec(String(version).trim());
	return match ? Number(match[1]) : 0;
}

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
	return parseMajor(version) >= MIN_NODE_MAJOR ? version : { tooOld: version };
}

/**
 * Resolves the node + npm pair used to install and run the daemon.
 * Prefers a managed runtime (deterministic version) and falls back to a
 * host Node.js that satisfies MIN_NODE_MAJOR.
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

/** Spawns npm through whichever toolchain was resolved. */
function runNpm(toolchain, args, options = {}) {
	if (toolchain.npm?.kind === "script" && toolchain.npm.script) {
		return run(toolchain.nodePath, [toolchain.npm.script, ...args], options);
	}
	if (toolchain.npm?.kind === "command") {
		return run(toolchain.npm.command, args, { ...options, shell: toolchain.npm.shell });
	}
	return Promise.resolve({ code: -1, stdout: "", stderr: "no npm available in the resolved toolchain" });
}

module.exports = {
	MIN_NODE_MAJOR,
	isWindows,
	run,
	runNpm,
	parseMajor,
	probeNode,
	resolveToolchain,
	managedRuntimeDir,
	managedNodePath,
	platformLabel: () => `${process.platform}-${process.arch} (${os.release()})`,
};
