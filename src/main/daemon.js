"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { paths, ensureDirs } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { isWindows, resolveToolchain } = require("./toolchain");
const { findFreePort, daemonEntry } = require("./env-check");

const emitter = new EventEmitter();
const MAX_LOG_LINES = 500;

const state = {
	status: "stopped", // stopped | starting | running | error
	child: null,
	pid: null,
	url: null,
	host: null,
	port: null,
	startedAt: null,
	lastError: null,
	logs: [],
};

function pushLog(line) {
	const text = String(line).replace(/\s+$/, "");
	if (!text) return;
	state.logs.push({ ts: Date.now(), text });
	if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
	logger.info("daemon", text);
	emitter.emit("log", { ts: Date.now(), text });
}

function setStatus(patch) {
	Object.assign(state, patch);
	emitter.emit("status", status());
}

function status() {
	// `child` and `logs` are intentionally dropped: the child process is not
	// structured-cloneable across IPC and logs have their own channel.
	const { logs, child, ...rest } = state;
	return { ...rest, runtimeVersion: config.get().runtimeVersion };
}

function buildArgs(settings, port) {
	const args = [
		"http",
		"--host",
		settings.host,
		"--port",
		String(port),
		"--memory-backend",
		settings.memoryBackend,
		"--embedding-provider",
		settings.embeddingProvider,
		"--insights-backend",
		settings.insightsBackend,
		"--knowledge-backend",
		settings.knowledgeBackend,
	];
	if (settings.embeddingModel) args.push("--embedding-model", settings.embeddingModel);
	if (settings.chromaUrl) args.push("--chroma-url", settings.chromaUrl);
	return args;
}

function daemonEnv(extra = {}) {
	ensureDirs();
	const env = {
		...process.env,
		NODE_ENV: "production",
		MEMORY_STORE_DB_PATH: paths.dbFile,
		OPENCONTEXT_HOME: paths.root,
		...extra,
	};
	// Electron sets these for its own helper processes; they would confuse a
	// plain Node.js child.
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_OPTIONS;
	return env;
}

async function waitForHealth(host, port, timeoutMs, isAlive) {
	const deadline = Date.now() + timeoutMs;
	let lastError = "未收到响应";
	while (Date.now() < deadline) {
		if (isAlive && !isAlive()) return { ok: false, detail: lastError || "进程已退出" };
		try {
			const response = await fetch(`http://${host}:${port}/health`, {
				signal: AbortSignal.timeout(3000),
			});
			if (response.ok) {
				const body = await response.json().catch(() => ({}));
				return { ok: true, detail: `GET /health → ${JSON.stringify(body)}` };
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error.message;
		}
		await new Promise((resolve) => setTimeout(resolve, 600));
	}
	return { ok: false, detail: lastError };
}

function killProcess(child) {
	if (!child || child.exitCode !== null) return;
	if (isWindows) {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
	} else {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 4000);
	}
}

async function start() {
	if (state.status === "running" || state.status === "starting") return status();
	const settings = config.settings;
	const entry = daemonEntry();
	if (!fs.existsSync(entry)) {
		setStatus({ status: "error", lastError: "运行时未安装，请先完成环境安装" });
		return status();
	}
	const toolchain = await resolveToolchain();
	if (!toolchain.ok) {
		setStatus({ status: "error", lastError: "未找到可用的 Node.js 运行时" });
		return status();
	}
	const port = await findFreePort(settings.port, settings.host);
	if (!port) {
		setStatus({ status: "error", lastError: "没有可用端口" });
		return status();
	}

	setStatus({ status: "starting", lastError: null, host: settings.host, port, url: null });
	const args = buildArgs(settings, port);
	pushLog(`$ ${toolchain.nodePath} ${entry} ${args.join(" ")}`);

	const child = spawn(toolchain.nodePath, [entry, ...args], {
		cwd: paths.dataDir,
		env: daemonEnv(),
		windowsHide: true,
	});
	state.child = child;
	child.stdout.on("data", (chunk) => pushLog(chunk.toString()));
	child.stderr.on("data", (chunk) => pushLog(chunk.toString()));
	child.on("error", (error) => {
		setStatus({ status: "error", lastError: error.message, pid: null });
	});
	child.on("exit", (code, signal) => {
		pushLog(`服务进程退出（code=${code} signal=${signal ?? "none"}）`);
		state.child = null;
		if (state.status !== "stopped") {
			setStatus({
				status: code === 0 ? "stopped" : "error",
				pid: null,
				url: null,
				lastError: code === 0 ? null : `服务进程异常退出，code=${code}`,
			});
		}
	});

	const health = await waitForHealth(settings.host, port, 90_000, () => state.child === child);
	if (!health.ok) {
		killProcess(child);
		setStatus({ status: "error", lastError: `健康检查失败：${health.detail}`, pid: null, url: null });
		return status();
	}
	setStatus({
		status: "running",
		pid: child.pid,
		url: `http://${settings.host}:${port}`,
		startedAt: Date.now(),
		lastError: null,
	});
	pushLog(`服务已就绪：http://${settings.host}:${port}`);
	return status();
}

async function stop() {
	const child = state.child;
	setStatus({ status: "stopped", pid: null, url: null });
	if (child) {
		killProcess(child);
		state.child = null;
	}
	return status();
}

async function restart() {
	await stop();
	await new Promise((resolve) => setTimeout(resolve, 500));
	return start();
}

/** One-off boot used by the installer to prove the runtime actually works. */
async function probeDaemon(toolchain) {
	const resolved = toolchain?.ok ? toolchain : await resolveToolchain();
	if (!resolved.ok) return { ok: false, detail: "没有可用的 Node.js 运行时" };
	const entry = daemonEntry();
	if (!fs.existsSync(entry)) return { ok: false, detail: "未找到 opencontext 入口文件" };
	const host = "127.0.0.1";
	const port = await findFreePort(17421, host);
	if (!port) return { ok: false, detail: "没有可用端口" };

	const child = spawn(
		resolved.nodePath,
		[entry, "http", "--host", host, "--port", String(port), "--memory-backend", "sqlite-vec"],
		{ cwd: paths.dataDir, env: daemonEnv(), windowsHide: true },
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
		logger.info("verify", chunk.toString().trim());
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
		logger.warn("verify", chunk.toString().trim());
	});
	try {
		const health = await waitForHealth(host, port, 90_000, () => child.exitCode === null);
		return health.ok ? health : { ok: false, detail: `${health.detail} ${output.slice(-400)}`.trim() };
	} finally {
		killProcess(child);
	}
}

/** Proxies a renderer request to the running daemon (keeps the UI off the network). */
async function apiRequest({ method = "GET", path: endpoint = "/health", body }) {
	if (!state.url) throw new Error("服务未运行");
	const response = await fetch(`${state.url}${endpoint}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(120_000),
	});
	const text = await response.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { raw: text };
	}
	return { ok: response.ok, status: response.status, body: parsed };
}

module.exports = {
	emitter,
	start,
	stop,
	restart,
	status,
	logs: () => state.logs.slice(),
	probeDaemon,
	apiRequest,
};
