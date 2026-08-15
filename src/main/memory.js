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

/** Hides one note from every view (soft delete, same semantics as the runtime). */
async function remove(id) {
	const messageId = String(id ?? "").trim();
	if (!messageId) throw new Error("缺少要删除的记录编号");
	const local = await runLocal("delete", { id: messageId });
	if (!local.removed) throw new Error("没找到这条记录，可能已经删除了");
	logger.info("memory", `已删除一条记录（${messageId}）`);
	return { removed: local.removed };
}

/** Undo for a delete the user did not mean. */
async function restore(id) {
	const messageId = String(id ?? "").trim();
	if (!messageId) throw new Error("缺少要恢复的记录编号");
	const local = await runLocal("restore", { id: messageId });
	if (!local.restored) throw new Error("没找到这条记录");
	logger.info("memory", `已恢复一条记录（${messageId}）`);
	return { restored: local.restored };
}

async function all() {
	const local = await runLocal("all");
	return local.items;
}

/** Paginated library view with optional tag filter. */
async function browse({ offset = 0, limit = 20, tag = "", order = "desc" } = {}) {
	const local = await runLocal("browse", { offset, limit, tag, order });
	return { items: local.items, total: local.total };
}

async function tags() {
	const local = await runLocal("tags");
	return local.items;
}

async function stats(days = 14) {
	const local = await runLocal("stats", { days });
	return { total: local.total, first: local.first, days: local.days, byDay: local.byDay, byTag: local.byTag };
}

module.exports = { save, search, recent, count, remove, restore, all, browse, tags, stats, userId };
