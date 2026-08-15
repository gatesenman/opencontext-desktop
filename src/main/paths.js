"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const root = app.getPath("userData");

const paths = {
	root,
	/** Managed Node.js runtime, downloaded on first run when the host has none. */
	runtimeDir: path.join(root, "node-runtime"),
	/** npm prefix holding the OpenContext runtime packages. */
	serverDir: path.join(root, "server"),
	/** SQLite database + anything the runtime persists. */
	dataDir: path.join(root, "data"),
	logsDir: path.join(root, "logs"),
	configFile: path.join(root, "config.json"),
};

paths.dbFile = path.join(paths.dataDir, "memory.db");
paths.desktopLog = path.join(paths.logsDir, "desktop.log");
paths.daemonLog = path.join(paths.logsDir, "daemon.log");
paths.installLog = path.join(paths.logsDir, "install.log");

function ensureDirs() {
	for (const dir of [paths.root, paths.dataDir, paths.logsDir]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

module.exports = { paths, ensureDirs };
