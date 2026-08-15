"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { paths } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { resolveToolchain } = require("./toolchain");
const daemon = require("./daemon");

/** Scripts live outside the asar archive so the managed Node.js can run them. */
const SCRIPT = path
	.join(__dirname, "scripts", "local-store.js")
	.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const DEFAULT_USER = "me";

function userId() {
	return config.settings.userId?.trim() || DEFAULT_USER;
}

function runLocal(action, extra = {}) {
	return resolveToolchain().then(
		(toolchain) =>
			new Promise((resolve, reject) => {
				if (!toolchain.ok) return reject(new Error("未找到可用的 Node.js 运行时"));
				const request = { dbFile: paths.dbFile, serverDir: paths.serverDir, userId: userId(), ...extra };
				const child = spawn(toolchain.nodePath, [SCRIPT, action, JSON.stringify(request)], {
					cwd: paths.serverDir,
					windowsHide: true,
				});
				let out = "";
				let err = "";
				child.stdout.on("data", (chunk) => {
					out += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					err += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", () => {
					try {
						const parsed = JSON.parse(out);
						if (!parsed.ok) return reject(new Error(parsed.error ?? "本地检索失败"));
						resolve(parsed);
					} catch {
						reject(new Error(err.trim().slice(-300) || "本地检索没有返回结果"));
					}
				});
			}),
	);
}

/** Writes one note through the running daemon (keeps server side hooks alive). */
async function save({ text, tag }) {
	const content = String(text ?? "").trim();
	if (!content) throw new Error("请先输入要记住的内容");
	const now = Date.now();
	const messageId = `note-${now}-${Math.random().toString(36).slice(2, 8)}`;
	const user = userId();
	const response = await daemon.apiRequest({
		method: "POST",
		path: "/v1/raw-messages",
		body: {
			userId: user,
			embedOnInsert: config.settings.embeddingProvider !== "none",
			messages: [
				{
					messageId,
					userId: user,
					content,
					platform: "desktop",
					botId: "desktop",
					channel: tag?.trim() || undefined,
					timestamp: now,
					createdAt: now,
				},
			],
		},
	});
	if (!response.ok) {
		throw new Error(response.body?.error ?? `写入失败（HTTP ${response.status}）`);
	}
	logger.info("memory", `已记住一条内容（${messageId}）`);
	return { messageId, ts: now, content };
}

function normalizeHits(results) {
	return (Array.isArray(results) ? results : []).map((hit) => ({
		id: hit.id ?? hit.messageId ?? "",
		content: hit.content ?? hit.text ?? "",
		ts: hit.timestamp ?? hit.createdAt ?? hit.metadata?.timestamp ?? null,
		score: typeof hit.similarity === "number" ? Number(hit.similarity.toFixed(3)) : undefined,
		source: hit.source ?? "memory",
	}));
}

/**
 * Beginner friendly search: try the server's unified (semantic) search first and
 * silently fall back to the offline keyword index, so results never depend on
 * the user configuring an embedding model.
 */
async function search({ query, limit = 10 }) {
	const text = String(query ?? "").trim();
	if (!text) throw new Error("请先输入要搜索的内容");
	let note = "";

	if (daemon.status().status === "running" && config.settings.embeddingProvider !== "none") {
		try {
			const response = await daemon.apiRequest({
				method: "POST",
				path: "/v1/search",
				body: { userId: userId(), query: text, limit },
			});
			const items = normalizeHits(response.body?.results);
			if (items.length > 0) return { mode: "semantic", items, note: "语义检索结果" };
			const failed = (response.body?.warnings ?? []).find((warning) => warning.code === "memory_search_failed");
			note = failed ? "智能检索暂不可用，已改用关键词搜索。" : "";
		} catch (error) {
			note = `智能检索失败（${error.message}），已改用关键词搜索。`;
		}
	}

	const local = await runLocal("search", { query: text, limit });
	return {
		mode: "keyword",
		items: local.items,
		note: note || "关键词搜索结果（开启智能检索后可按含义匹配）",
	};
}

async function recent(limit = 20) {
	const local = await runLocal("recent", { limit });
	return local.items;
}

async function count() {
	const local = await runLocal("count");
	return local.total;
}

module.exports = { save, search, recent, count, userId };
