"use strict";

/**
 * Offline helper executed with the managed Node.js runtime (never inside
 * Electron, whose ABI does not match the native better-sqlite3 build shipped
 * with the OpenContext runtime).
 *
 * Usage: node local-store.js <action> <json-payload>
 * Actions: recent | search | count | all | delete | restore
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
	const db = openDatabase(action === "delete" || action === "restore");
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
					`SELECT message_id, content, timestamp, created_at, platform, embedding
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL
					 ORDER BY timestamp DESC, id DESC
					 LIMIT ?`,
				)
				.all(payload.userId, Math.min(Number(payload.limit) || 20, 200));
			return { ok: true, items: rows.map(rowToItem) };
		}

		if (action === "all") {
			const rows = db
				.prepare(
					`SELECT message_id, content, timestamp, created_at, platform, embedding
					 FROM raw_messages
					 WHERE user_id = ? AND deprecated_at IS NULL
					 ORDER BY timestamp ASC, id ASC`,
				)
				.all(payload.userId);
			return { ok: true, items: rows.map(rowToItem) };
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
					`SELECT message_id, content, timestamp, created_at, platform, embedding
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
