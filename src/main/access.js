"use strict";

/**
 * External access for AI tools:
 * - MCP: builds a ready-to-paste MCP client config that runs `opencontext mcp`
 *   (stdio) with the managed runtime against the same local database.
 * - HTTP tokens: the OpenContext HTTP daemon itself has no authentication, so
 *   a small proxy in the main process enforces `Authorization: Bearer <token>`
 *   and forwards to the daemon. Tokens are created/revoked in the UI.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { paths } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { resolveToolchain } = require("./toolchain");
const { findFreePort, daemonEntry } = require("./env-check");
const daemon = require("./daemon");

/* ── token store (persisted in config.json, values are local-only) ───── */

function listTokens() {
	return (config.get().tokens ?? []).map((token) => ({ ...token }));
}

function createToken(name) {
	const label = String(name ?? "").trim() || `令牌 ${listTokens().length + 1}`;
	const token = {
		id: crypto.randomUUID(),
		name: label,
		value: `oc_${crypto.randomBytes(24).toString("base64url")}`,
		createdAt: Date.now(),
		lastUsedAt: null,
	};
	config.patch({ tokens: [...listTokens(), token] });
	logger.info("access", `已创建访问令牌「${label}」`);
	syncProxy();
	return token;
}

function revokeToken(id) {
	const kept = listTokens().filter((token) => token.id !== id);
	config.patch({ tokens: kept });
	logger.info("access", "已吊销一个访问令牌");
	syncProxy();
	return kept;
}

function touchToken(id) {
	config.patch({
		tokens: listTokens().map((token) => (token.id === id ? { ...token, lastUsedAt: Date.now() } : token)),
	});
}

/* ── authenticated HTTP proxy in front of the daemon ─────────────────── */

const proxy = {
	server: null,
	port: null,
};

function proxyStatus() {
	return {
		running: Boolean(proxy.server),
		port: proxy.port,
		url: proxy.port ? `http://127.0.0.1:${proxy.port}` : null,
		tokens: listTokens().length,
	};
}

function matchToken(header) {
	const value = String(header ?? "");
	if (!value.toLowerCase().startsWith("bearer ")) return null;
	const raw = value.slice(7).trim();
	return listTokens().find((token) => {
		const a = Buffer.from(token.value);
		const b = Buffer.from(raw);
		return a.length === b.length && crypto.timingSafeEqual(a, b);
	});
}

async function startProxy() {
	if (proxy.server) return proxyStatus();
	const upstream = daemon.status();
	if (upstream.status !== "running" || !upstream.url) return proxyStatus();
	const port = await findFreePort(config.settings.tokenProxyPort || 7431, "127.0.0.1");
	if (!port) return proxyStatus();

	const server = http.createServer(async (request, response) => {
		const token = matchToken(request.headers.authorization);
		if (!token) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "missing or invalid bearer token" }));
			return;
		}
		touchToken(token.id);
		try {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			const target = daemon.status().url;
			if (!target) throw new Error("服务未运行");
			const upstreamResponse = await fetch(`${target}${request.url}`, {
				method: request.method,
				headers: { "content-type": request.headers["content-type"] ?? "application/json" },
				body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
				signal: AbortSignal.timeout(120_000),
			});
			const text = await upstreamResponse.text();
			response.writeHead(upstreamResponse.status, {
				"content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
			});
			response.end(text);
		} catch (error) {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: error.message }));
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	}).catch((error) => {
		logger.warn("access", `令牌代理启动失败：${error.message}`);
		return null;
	});
	if (!server.listening) return proxyStatus();

	proxy.server = server;
	proxy.port = port;
	logger.info("access", `令牌保护接口已就绪：http://127.0.0.1:${port}`);
	return proxyStatus();
}

function stopProxy() {
	if (proxy.server) {
		proxy.server.close();
		proxy.server = null;
		proxy.port = null;
	}
	return proxyStatus();
}

/** Keeps the proxy alive exactly when the daemon runs and tokens exist. */
async function syncProxy() {
	const shouldRun = daemon.status().status === "running" && listTokens().length > 0;
	if (shouldRun && !proxy.server) return startProxy();
	if (!shouldRun && proxy.server) return stopProxy();
	return proxyStatus();
}

/* ── MCP client config ───────────────────────────────────────────────── */

async function mcpConfig() {
	const toolchain = await resolveToolchain();
	const settings = config.settings;
	const entry = daemonEntry();
	const args = [entry, "mcp", "--memory-backend", settings.memoryBackend];
	if (settings.embeddingProvider !== "none") {
		args.push("--embedding-provider", settings.embeddingProvider);
		if (settings.embeddingModel) args.push("--embedding-model", settings.embeddingModel);
	}
	const server = {
		command: toolchain.ok ? toolchain.nodePath : "node",
		args,
		env: {
			MEMORY_STORE_DB_PATH: paths.dbFile,
			OPENCONTEXT_HOME: paths.root,
		},
	};
	return {
		available: toolchain.ok,
		server,
		/** Claude Desktop / Cursor style config file snippet. */
		json: JSON.stringify({ mcpServers: { opencontext: server } }, null, 2),
	};
}

module.exports = {
	listTokens,
	createToken,
	revokeToken,
	proxyStatus,
	syncProxy,
	stopProxy,
	mcpConfig,
};
