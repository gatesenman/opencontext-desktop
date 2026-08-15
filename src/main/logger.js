"use strict";

const fs = require("node:fs");
const { paths, ensureDirs } = require("./paths");

const MAX_BUFFER = 800;
const buffer = [];
const listeners = new Set();

let stream = null;

function openStream() {
	if (stream) return stream;
	ensureDirs();
	stream = fs.createWriteStream(paths.desktopLog, { flags: "a" });
	return stream;
}

function push(scope, level, message) {
	const entry = {
		ts: Date.now(),
		scope,
		level,
		message: String(message).replace(/\s+$/, ""),
	};
	buffer.push(entry);
	if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
	try {
		openStream().write(`${new Date(entry.ts).toISOString()} [${scope}/${level}] ${entry.message}\n`);
	} catch {
		// Logging must never break the app.
	}
	for (const listener of listeners) {
		try {
			listener(entry);
		} catch {
			// ignore listener failures
		}
	}
	return entry;
}

const logger = {
	info: (scope, message) => push(scope, "info", message),
	warn: (scope, message) => push(scope, "warn", message),
	error: (scope, message) => push(scope, "error", message),
	history: () => buffer.slice(),
	onEntry(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

module.exports = { logger };
