"use strict";

/**
 * Offline helper executed with the managed Node.js runtime (never inside
 * Electron, whose ABI does not match the native better-sqlite3 build shipped
 * with the OpenContext runtime).
 *
 * Usage: node local-store.js <action> <json-payload>
 * Actions: recent | search | count | all | delete | restore | browse | tags |
 *          stats | get | update | trash | purge | existing
 */

const fs = require("node:fs");
const path = require("node:path");

const [action, rawPayload] = process.argv.slice(2);
const payload = JSON.parse(rawPayload ?? "{}");

function openDatabase(writable = false) {
	const Database = require(path.join(payload.serverDir, "node_modules", "better-sqlite3"));
	const db = new Database(payload.dbFile, { readonly: !writable, fileMustExist: true });
	/** The daemon holds the same file open, so never fail instantly on a lock. */
	db.pragma("busy_timeout = 4000");
	return db;
}

function rowToItem(row) {
	return {
		id: row.message_id,
		content: row.content,
		ts: row.timestamp ?? row.created_at,
		platform: row.platform,
		tag: row.channel ?? "",
		hasEmbedding: Boolean(row.embedding),
	};
}

/**
 * Query terms that behave reasonably for both space separated languages and
 * CJK text: latin/number words plus CJK bigrams (the FTS5 unicode61 tokenizer
 * treats a whole Chinese phrase as one token, so bigrams give usable recall).
 */
function terms(query) {
	const text = String(query ?? "").toLowerCase();
	const latin = text.match(/[a-z0-9_]{2,}/g) ?? [];
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) ?? [];
	const grams = [];
	for (const run of cjk) {
		if (run.length === 1) grams.push(run);
		for (let i = 0; i + 2 <= run.length; i += 1) grams.push(run.slice(i, i + 2));
	}
	return [...new Set([...latin, ...grams])];
}

function score(content, tokens) {
	const text = String(content ?? "").toLowerCase();
	let total = 0;
	let matched = 0;
	for (const token of tokens) {
		let from = 0;
		let hits = 0;
		for (;;) {
			const at = text.indexOf(token, from);
			if (at === -1) break;
			hits += 1;
			from = at + token.length;
		}
		if (hits > 0) {
			matched += 1;
			total += Math.min(hits, 4) * token.length;
		}
	}
	return tokens.length === 0 ? 0 : (total * matched) / tokens.length;
}

function run() {
	if (!fs.existsSync(payload.dbFile)) {
		return { ok: true, items: [], total: 0, empty: true };
	}
	const db = openDatabase(["delete", "restore", "update", "purge"].includes(action));
	try {
		const table = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_messages'")
			.get();
		if (!table) return { ok: true, items: [], total: 0, empty: true };

		if (action === "count") {
			const row = db
				.prepare("SELECT COUNT(*) AS total FROM raw_messages WHERE user_id = ? AND deprecated_at IS NULL")
				.get(payload.userId);
			return { ok: true, total: row?.total ?? 0 };
		}

		if (action === "recent") {
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL
					 ORDER BY timestamp DESC, id DESC
					 LIMIT ?`,
				)
				.all(payload.userId, Math.min(Number(payload.limit) || 20, 200));
			return { ok: true, items: rows.map(rowToItem) };
		}

		/** Full library view: tag filter + order + pagination in one query. */
		if (action === "browse") {
			const tag = String(payload.tag ?? "").trim();
			const order = payload.order === "asc" ? "ASC" : "DESC";
			const where = `user_id = ? AND deprecated_at IS NULL${tag ? " AND channel = ?" : ""}`;
			const args = tag ? [payload.userId, tag] : [payload.userId];
			const total = db.prepare(`SELECT COUNT(*) AS total FROM raw_messages WHERE ${where}`).get(...args)?.total ?? 0;
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding
					 FROM raw_messages
					 WHERE ${where}
					 ORDER BY timestamp ${order}, id ${order}
					 LIMIT ? OFFSET ?`,
				)
				.all(...args, Math.min(Number(payload.limit) || 20, 100), Math.max(Number(payload.offset) || 0, 0));
			return { ok: true, items: rows.map(rowToItem), total };
		}

		if (action === "tags") {
			const rows = db
				.prepare(
					`SELECT channel AS tag, COUNT(*) AS total FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL AND channel IS NOT NULL AND channel != ''
					 GROUP BY channel ORDER BY total DESC LIMIT 50`,
				)
				.all(payload.userId);
			return { ok: true, items: rows };
		}

		if (action === "stats") {
			const days = Math.min(Number(payload.days) || 14, 60);
			const since = Date.now() - days * 86_400_000;
			const total = db
				.prepare("SELECT COUNT(*) AS total FROM raw_messages WHERE user_id = ? AND deprecated_at IS NULL")
				.get(payload.userId)?.total ?? 0;
			const first = db
				.prepare(
					"SELECT MIN(COALESCE(timestamp, created_at)) AS ts FROM raw_messages WHERE user_id = ? AND deprecated_at IS NULL",
				)
				.get(payload.userId)?.ts ?? null;
			const byDay = db
				.prepare(
					`SELECT date(COALESCE(timestamp, created_at) / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS total
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL AND COALESCE(timestamp, created_at) >= ?
					 GROUP BY day ORDER BY day ASC`,
				)
				.all(payload.userId, since);
			const byTag = db
				.prepare(
					`SELECT COALESCE(NULLIF(channel, ''), '未分类') AS tag, COUNT(*) AS total FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL GROUP BY tag ORDER BY total DESC LIMIT 8`,
				)
				.all(payload.userId);
			return { ok: true, total, first, days, byDay, byTag };
		}

		if (action === "all") {
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL
					 ORDER BY timestamp ASC, id ASC`,
				)
				.all(payload.userId);
			return { ok: true, items: rows.map(rowToItem) };
		}

		if (action === "get") {
			const row = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding
					 FROM raw_messages WHERE user_id = ? AND message_id = ?`,
				)
				.get(payload.userId, String(payload.id ?? ""));
			return row ? { ok: true, item: rowToItem(row) } : { ok: false, error: "记录不存在" };
		}

		/** In-place edit: keeps the original timestamp, drops the stale embedding. */
		if (action === "update") {
			const result = db
				.prepare(
					`UPDATE raw_messages
					 SET content = ?, channel = ?, embedding = NULL, embedding_model = NULL,
					     embedding_content_hash = NULL, embedding_updated_at = NULL
					 WHERE user_id = ? AND message_id = ?`,
				)
				.run(
					String(payload.content ?? ""),
					String(payload.tag ?? "").trim() || null,
					payload.userId,
					String(payload.id ?? ""),
				);
			return { ok: true, updated: result.changes };
		}

		/** Recycle bin: everything soft-deleted, newest deletion first. */
		if (action === "trash") {
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding, deprecated_at
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NOT NULL
					 ORDER BY deprecated_at DESC
					 LIMIT ?`,
				)
				.all(payload.userId, Math.min(Number(payload.limit) || 100, 500));
			return { ok: true, items: rows.map((row) => ({ ...rowToItem(row), deletedAt: row.deprecated_at })) };
		}

		/** Hard delete a soft-deleted row (or empty the whole recycle bin). */
		if (action === "purge") {
			const result = payload.id
				? db
						.prepare(
							"DELETE FROM raw_messages WHERE user_id = ? AND message_id = ? AND deprecated_at IS NOT NULL",
						)
						.run(payload.userId, String(payload.id))
				: db
						.prepare("DELETE FROM raw_messages WHERE user_id = ? AND deprecated_at IS NOT NULL")
						.run(payload.userId);
			return { ok: true, purged: result.changes };
		}

		/** Which of the candidate ids already exist (import dedupe). */
		if (action === "existing") {
			const ids = Array.isArray(payload.ids) ? payload.ids.map(String).slice(0, 20_000) : [];
			const found = new Set();
			const probe = db.prepare("SELECT 1 FROM raw_messages WHERE message_id = ?");
			for (const id of ids) if (probe.get(id)) found.add(id);
			return { ok: true, ids: [...found] };
		}

		/** Soft delete: the runtime already treats deprecated rows as gone. */
		if (action === "delete") {
			const result = db
				.prepare("UPDATE raw_messages SET deprecated_at = ? WHERE user_id = ? AND message_id = ?")
				.run(Date.now(), payload.userId, String(payload.id ?? ""));
			return { ok: true, removed: result.changes };
		}

		/** Undo for an accidental delete. */
		if (action === "restore") {
			const result = db
				.prepare("UPDATE raw_messages SET deprecated_at = NULL WHERE user_id = ? AND message_id = ?")
				.run(payload.userId, String(payload.id ?? ""));
			return { ok: true, restored: result.changes };
		}

		if (action === "search") {
			const tokens = terms(payload.query);
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, channel, embedding
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL
					 ORDER BY timestamp DESC, id DESC
					 LIMIT 4000`,
				)
				.all(payload.userId);
			const limit = Math.min(Number(payload.limit) || 10, 100);
			const scored = rows
				.map((row) => ({ item: rowToItem(row), value: score(row.content, tokens) }))
				.filter((entry) => entry.value > 0)
				.sort((a, b) => b.value - a.value || b.item.ts - a.item.ts)
				.slice(0, limit)
				.map((entry) => ({ ...entry.item, score: Number(entry.value.toFixed(2)) }));
			return { ok: true, items: scored, tokens };
		}

		return { ok: false, error: `未知操作：${action}` };
	} finally {
		db.close();
	}
}

try {
	process.stdout.write(JSON.stringify(run()));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
