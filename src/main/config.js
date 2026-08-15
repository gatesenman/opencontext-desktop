"use strict";

const fs = require("node:fs");
const { paths, ensureDirs } = require("./paths");
const { logger } = require("./logger");

const DEFAULTS = {
	/** Set once the runtime finished installing and passed its health check. */
	installed: false,
	installedAt: null,
	/** Version of @melandlabs/opencontext currently installed under serverDir. */
	runtimeVersion: null,
	/** Absolute path of the node binary used to run the daemon. */
	nodePath: null,
	/** "system" when the host Node.js is reused, "managed" for the downloaded one. */
	nodeSource: null,
	nodeVersion: null,
	settings: {
		host: "127.0.0.1",
		port: 7421,
		/** Owner of every note written from this desktop app. */
		userId: "me",
		/** false reveals the advanced/developer sections in the sidebar. */
		simpleMode: true,
		/** none keeps the install light; local pulls a ~90 MB embedding model on first search. */
		embeddingProvider: "none",
		embeddingModel: "",
		memoryBackend: "sqlite-vec",
		insightsBackend: "none",
		knowledgeBackend: "none",
		chromaUrl: "",
		autoStartDaemon: true,
		autoCheckUpdates: true,
		/** Optional external URL to embed instead of the built-in panel. */
		embeddedUrl: "",
		npmRegistry: "",
		nodeMirror: "https://nodejs.org/dist",
		runtimeChannel: "latest",
	},
};

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function merge(base, patch) {
	const out = clone(base);
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = merge(base[key] ?? {}, value);
		} else if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

let state = clone(DEFAULTS);
let loaded = false;

function load() {
	if (loaded) return state;
	loaded = true;
	try {
		const raw = fs.readFileSync(paths.configFile, "utf8");
		state = merge(DEFAULTS, JSON.parse(raw));
	} catch (error) {
		if (error.code !== "ENOENT") {
			logger.warn("config", `unreadable config, falling back to defaults: ${error.message}`);
		}
		state = clone(DEFAULTS);
	}
	return state;
}

function save() {
	ensureDirs();
	fs.writeFileSync(paths.configFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return state;
}

const config = {
	get() {
		return clone(load());
	},
	get settings() {
		return clone(load().settings);
	},
	patch(patch) {
		state = merge(load(), patch);
		save();
		return clone(state);
	},
	patchSettings(patch) {
		return config.patch({ settings: patch });
	},
	reset() {
		state = clone(DEFAULTS);
		save();
		return clone(state);
	},
	defaults: DEFAULTS,
};

module.exports = { config };
