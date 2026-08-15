"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const tar = require("tar-fs");
const yauzl = require("yauzl");
const { paths, ensureDirs } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { isWindows, resolveToolchain, runNpm } = require("./toolchain");
const { daemonEntry, installedRuntimeVersion, REGISTRY_FALLBACK } = require("./env-check");
const { probeDaemon } = require("./daemon");

const FALLBACK_NODE_VERSION = "v20.19.4";
const RUNTIME_PACKAGES = ["@melandlabs/opencontext", "@melandlabs/ai-rag"];

let running = false;

function nodeArchiveName(version) {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (isWindows) return `node-${version}-win-${arch}.zip`;
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	return `node-${version}-${platform}-${arch}.tar.gz`;
}

/** Newest LTS line that is still ≥ 20, so the daemon's native deps have prebuilds. */
async function resolveNodeVersion(mirror) {
	try {
		const response = await fetch(`${mirror.replace(/\/$/, "")}/index.json`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const entries = await response.json();
		const lts = entries.filter((entry) => entry.lts && Number(entry.version.slice(1).split(".")[0]) >= 20);
		return lts[0]?.version ?? FALLBACK_NODE_VERSION;
	} catch (error) {
		logger.warn("installer", `无法读取 Node 版本清单（${error.message}），回退到 ${FALLBACK_NODE_VERSION}`);
		return FALLBACK_NODE_VERSION;
	}
}

async function expectedChecksum(mirror, version, archive) {
	try {
		const response = await fetch(`${mirror.replace(/\/$/, "")}/${version}/SHASUMS256.txt`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const text = await response.text();
		const line = text.split("\n").find((row) => row.trim().endsWith(archive));
		return line ? line.trim().split(/\s+/)[0] : null;
	} catch {
		return null;
	}
}

async function downloadFile(url, destination, onProgress) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`下载失败 ${url} — HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length") ?? 0);
	let received = 0;
	const hash = crypto.createHash("sha256");
	const source = Readable.fromWeb(response.body);
	source.on("data", (chunk) => {
		received += chunk.length;
		hash.update(chunk);
		if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)), received, total);
	});
	await pipeline(source, fs.createWriteStream(destination));
	return { digest: hash.digest("hex"), bytes: received };
}

async function extractTarGz(archivePath, destination) {
	await pipeline(fs.createReadStream(archivePath), zlib.createGunzip(), tar.extract(destination));
}

function extractZip(archivePath, destination) {
	return new Promise((resolve, reject) => {
		yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
			if (openError) return reject(openError);
			zip.readEntry();
			zip.on("entry", (entry) => {
				const target = path.join(destination, entry.fileName);
				if (entry.fileName.endsWith("/")) {
					fs.mkdirSync(target, { recursive: true });
					zip.readEntry();
					return;
				}
				zip.openReadStream(entry, (streamError, readStream) => {
					if (streamError) return reject(streamError);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					pipeline(readStream, fs.createWriteStream(target))
						.then(() => zip.readEntry())
						.catch(reject);
				});
			});
			zip.on("end", resolve);
			zip.on("error", reject);
		});
	});
}

async function installNodeRuntime(emit) {
	const settings = config.settings;
	const mirror = settings.nodeMirror || "https://nodejs.org/dist";
	const version = await resolveNodeVersion(mirror);
	const archive = nodeArchiveName(version);
	const url = `${mirror.replace(/\/$/, "")}/${version}/${archive}`;

	fs.mkdirSync(paths.runtimeDir, { recursive: true });
	const archivePath = path.join(paths.runtimeDir, archive);

	emit({ step: "node", status: "running", percent: 0, message: `下载 Node.js ${version} — ${url}` });
	const expected = await expectedChecksum(mirror, version, archive);
	const { digest, bytes } = await downloadFile(url, archivePath, (percent, received, total) => {
		emit({
			step: "node",
			status: "running",
			percent,
			message: `下载 Node.js ${version} … ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`,
		});
	});
	if (expected && expected !== digest) {
		throw new Error(`Node.js 安装包校验失败：期望 ${expected}，实际 ${digest}`);
	}
	emit({
		step: "node",
		status: "running",
		percent: 100,
		message: `校验通过（${(bytes / 1e6).toFixed(1)} MB${expected ? ", sha256 匹配" : ""}），正在解压…`,
	});

	if (archive.endsWith(".zip")) {
		await extractZip(archivePath, paths.runtimeDir);
	} else {
		await extractTarGz(archivePath, paths.runtimeDir);
	}
	fs.rmSync(archivePath, { force: true });

	if (!isWindows) {
		const binary = path.join(paths.runtimeDir, archive.replace(/\.tar\.gz$/, ""), "bin", "node");
		if (fs.existsSync(binary)) fs.chmodSync(binary, 0o755);
	}
	emit({ step: "node", status: "ok", percent: 100, message: `内置 Node.js ${version} 安装完成` });
	return version;
}

async function installRuntimePackages(toolchain, emit) {
	const settings = config.settings;
	fs.mkdirSync(paths.serverDir, { recursive: true });
	const manifest = path.join(paths.serverDir, "package.json");
	if (!fs.existsSync(manifest)) {
		fs.writeFileSync(
			manifest,
			`${JSON.stringify({ name: "opencontext-desktop-runtime", private: true, version: "1.0.0" }, null, 2)}\n`,
		);
	}

	const channel = settings.runtimeChannel || "latest";
	const specs = RUNTIME_PACKAGES.map((name) => `${name}@${channel}`);
	const args = [
		"install",
		...specs,
		"--prefix",
		paths.serverDir,
		"--omit=dev",
		"--no-audit",
		"--no-fund",
		"--loglevel",
		"http",
	];
	if (settings.npmRegistry) args.push("--registry", settings.npmRegistry);

	emit({ step: "deps", status: "running", percent: 5, message: `npm ${args.slice(0, 3).join(" ")} …` });
	let ticks = 5;
	const result = await runNpm(toolchain, args, {
		cwd: paths.serverDir,
		env: {
			npm_config_cache: path.join(paths.root, "npm-cache"),
			npm_config_update_notifier: "false",
			ADBLOCK: "1",
		},
		onOutput: (chunk) => {
			ticks = Math.min(95, ticks + 1);
			for (const line of chunk.split("\n")) {
				const text = line.trim();
				if (!text) continue;
				logger.info("npm", text);
				emit({ step: "deps", status: "running", percent: ticks, message: text.slice(0, 200) });
			}
		},
	});
	if (result.code !== 0) {
		throw new Error(`npm 安装失败（exit ${result.code}）：${result.stderr.slice(-600) || "无输出"}`);
	}
	const version = installedRuntimeVersion();
	if (!version || !fs.existsSync(daemonEntry())) {
		throw new Error("npm 安装结束但未找到 opencontext 可执行入口");
	}
	emit({
		step: "deps",
		status: "ok",
		percent: 100,
		message: `@melandlabs/opencontext ${version} 安装完成（源：${settings.npmRegistry || REGISTRY_FALLBACK}）`,
	});
	return version;
}

/**
 * Full first-run flow: make sure a Node.js toolchain exists, install the
 * OpenContext runtime into the app data dir, then boot it once to prove the
 * install works. Marks the install as complete in config on success.
 */
async function install(emit) {
	if (running) throw new Error("安装已在进行中");
	running = true;
	ensureDirs();
	try {
		let toolchain = await resolveToolchain();
		if (!toolchain.ok) {
			await installNodeRuntime(emit);
			toolchain = await resolveToolchain();
			if (!toolchain.ok) throw new Error("内置 Node.js 安装后仍无法执行，请检查杀毒软件或目录权限");
		} else {
			emit({
				step: "node",
				status: "ok",
				percent: 100,
				message: `复用${toolchain.source === "managed" ? "内置" : "系统"} Node.js ${toolchain.nodeVersion}`,
			});
		}

		const runtimeVersion = await installRuntimePackages(toolchain, emit);

		emit({ step: "verify", status: "running", percent: 30, message: "启动一次本地服务做健康检查…" });
		const probe = await probeDaemon(toolchain);
		if (!probe.ok) throw new Error(`健康检查失败：${probe.detail}`);
		emit({ step: "verify", status: "ok", percent: 100, message: `健康检查通过：${probe.detail}` });

		config.patch({
			installed: true,
			installedAt: Date.now(),
			runtimeVersion,
			nodePath: toolchain.nodePath,
			nodeSource: toolchain.source,
			nodeVersion: toolchain.nodeVersion,
		});
		logger.info("installer", `安装完成，runtime=${runtimeVersion} node=${toolchain.nodeVersion}`);
		return { ok: true, runtimeVersion, toolchain };
	} catch (error) {
		logger.error("installer", error.stack ?? error.message);
		emit({ step: "error", status: "fail", percent: 100, message: error.message });
		return { ok: false, error: error.message };
	} finally {
		running = false;
	}
}

module.exports = { install, installNodeRuntime, resolveNodeVersion, RUNTIME_PACKAGES };
