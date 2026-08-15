"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { app } = require("electron");
const { paths, ensureDirs } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { MIN_NODE_MAJOR, isWindows, resolveToolchain, platformLabel } = require("./toolchain");

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const SUPPORTED_ARCH = new Set(["x64", "arm64"]);
const REGISTRY_FALLBACK = "https://registry.npmjs.org";

function daemonEntry() {
	return path.join(
		paths.serverDir,
		"node_modules",
		"@melandlabs",
		"opencontext",
		"dist",
		"cli",
		"opencontext.js",
	);
}

function installedRuntimeVersion() {
	try {
		const manifest = path.join(
			paths.serverDir,
			"node_modules",
			"@melandlabs",
			"opencontext",
			"package.json",
		);
		return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? null;
	} catch {
		return null;
	}
}

function isPortFree(port, host) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		server.listen(port, host);
	});
}

/** First free port at or after `start`, so a busy 7421 never blocks startup. */
async function findFreePort(start, host, attempts = 40) {
	for (let port = start; port < start + attempts; port += 1) {
		if (await isPortFree(port, host)) return port;
	}
	return 0;
}

async function checkRegistry(registry) {
	const url = registry || REGISTRY_FALLBACK;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(`${url.replace(/\/$/, "")}/@melandlabs%2fopencontext`, {
			signal: controller.signal,
			headers: { accept: "application/vnd.npm.install-v1+json" },
		});
		if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
		const body = await response.json();
		const latest = body?.["dist-tags"]?.latest ?? null;
		return { ok: true, detail: latest ? `latest ${latest}` : "reachable", latest };
	} catch (error) {
		return { ok: false, detail: error.name === "AbortError" ? "请求超时" : error.message };
	} finally {
		clearTimeout(timer);
	}
}

function checkWritable() {
	try {
		ensureDirs();
		const probe = path.join(paths.root, ".write-probe");
		fs.writeFileSync(probe, "ok");
		fs.unlinkSync(probe);
		return { ok: true, detail: paths.root };
	} catch (error) {
		return { ok: false, detail: error.message };
	}
}

/**
 * Runs every first-run check. Each result is
 * { id, label, status: ok|warn|fail, detail, fixable }.
 */
async function runChecks() {
	const settings = config.settings;
	const results = [];

	const platformOk = SUPPORTED_PLATFORMS.has(process.platform) && SUPPORTED_ARCH.has(process.arch);
	results.push({
		id: "platform",
		label: "电脑系统",
		status: platformOk ? "ok" : "fail",
		detail: platformLabel(),
	});

	const writable = checkWritable();
	results.push({
		id: "workdir",
		label: "数据保存位置",
		status: writable.ok ? "ok" : "fail",
		detail: writable.detail,
	});

	const toolchain = await resolveToolchain();
	results.push({
		id: "node",
		label: `运行环境 Node.js（需 ${MIN_NODE_MAJOR} 以上）`,
		status: toolchain.ok ? "ok" : "warn",
		detail: toolchain.ok
			? `${toolchain.nodeVersion} · ${toolchain.source === "managed" ? "应用内置" : "系统安装"} · ${toolchain.nodePath}`
			: "本机没有可用版本，安装时会自动下载一份自用的",
		fixable: !toolchain.ok,
	});

	results.push({
		id: "npm",
		label: "安装工具 npm",
		status: toolchain.ok && toolchain.npm ? "ok" : "warn",
		detail:
			toolchain.ok && toolchain.npm
				? toolchain.npm.kind === "script"
					? "使用内置运行时自带的 npm"
					: `系统 npm ${toolchain.npmVersion ?? ""}`.trim()
				: "会随运行环境一起装好",
		fixable: !(toolchain.ok && toolchain.npm),
	});

	const registry = await checkRegistry(settings.npmRegistry);
	results.push({
		id: "network",
		label: "网络连接",
		status: registry.ok ? "ok" : "warn",
		detail: `${settings.npmRegistry || REGISTRY_FALLBACK} — ${registry.detail}`,
		fixable: false,
	});

	const runtimeVersion = installedRuntimeVersion();
	const entryExists = fs.existsSync(daemonEntry());
	results.push({
		id: "runtime",
		label: "OpenContext 程序",
		status: runtimeVersion && entryExists ? "ok" : "warn",
		detail:
			runtimeVersion && entryExists
				? `@melandlabs/opencontext ${runtimeVersion}`
				: "还没安装，会自动装到本机数据目录",
		fixable: !(runtimeVersion && entryExists),
	});

	const port = await findFreePort(settings.port, settings.host);
	results.push({
		id: "port",
		label: "本机端口",
		status: port ? "ok" : "fail",
		detail: port
			? port === settings.port
				? `${settings.host}:${port} 可用`
				: `${settings.port} 被占用，将使用 ${port}`
			: "附近端口全部被占用",
	});

	const summary = {
		results,
		toolchain,
		runtimeVersion,
		port,
		latestRuntime: registry.latest ?? null,
		needsInstall: results.some((item) => item.fixable),
		blocked: results.some((item) => item.status === "fail"),
		appVersion: app.getVersion(),
		platform: platformLabel(),
		isWindows,
	};
	logger.info(
		"env",
		`检测完成：needsInstall=${summary.needsInstall} blocked=${summary.blocked} node=${toolchain.nodeVersion ?? "none"} runtime=${runtimeVersion ?? "none"}`,
	);
	return summary;
}

module.exports = { runChecks, findFreePort, daemonEntry, installedRuntimeVersion, REGISTRY_FALLBACK };
