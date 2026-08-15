"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");
const { config } = require("./config");
const { logger } = require("./logger");

const state = {
	status: "idle", // idle | checking | available | downloading | ready | not-available | error | unsupported
	version: null,
	percent: 0,
	notes: null,
	error: null,
	checkedAt: null,
};

let broadcast = () => {};

function update(patch) {
	Object.assign(state, patch);
	broadcast({ ...state, currentVersion: app.getVersion() });
}

function init(send) {
	broadcast = send;
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.logger = {
		info: (message) => logger.info("updater", message),
		warn: (message) => logger.warn("updater", message),
		error: (message) => logger.error("updater", message),
		debug: () => {},
	};

	autoUpdater.on("checking-for-update", () => update({ status: "checking", error: null }));
	autoUpdater.on("update-available", (info) => {
		update({ status: "available", version: info.version, notes: info.releaseNotes ?? null });
		if (config.settings.autoCheckUpdates) autoUpdater.downloadUpdate().catch(() => {});
	});
	autoUpdater.on("update-not-available", () =>
		update({ status: "not-available", checkedAt: Date.now(), percent: 0 }),
	);
	autoUpdater.on("download-progress", (progress) =>
		update({ status: "downloading", percent: Math.round(progress.percent) }),
	);
	autoUpdater.on("update-downloaded", (info) =>
		update({ status: "ready", version: info.version, percent: 100 }),
	);
	autoUpdater.on("error", (error) => update({ status: "error", error: error?.message ?? String(error) }));

	if (config.settings.autoCheckUpdates) {
		setTimeout(() => check().catch(() => {}), 8000);
		setInterval(() => check().catch(() => {}), 6 * 60 * 60 * 1000);
	}
}

async function check() {
	if (!app.isPackaged) {
		update({ status: "unsupported", error: "开发模式下不检查更新" });
		return { ...state };
	}
	try {
		// Returns null when the current install layout cannot self-update
		// (e.g. an extracted AppImage, or a Linux build without an updater).
		const result = await autoUpdater.checkForUpdates();
		if (!result) {
			update({
				status: "unsupported",
				error: "当前安装方式不支持自动更新，请到项目主页下载新版本",
			});
		}
	} catch (error) {
		update({ status: "error", error: error?.message ?? String(error) });
	}
	return { ...state };
}

async function download() {
	if (!app.isPackaged) return { ...state };
	try {
		await autoUpdater.downloadUpdate();
	} catch (error) {
		update({ status: "error", error: error?.message ?? String(error) });
	}
	return { ...state };
}

function install() {
	if (state.status !== "ready") return { ...state, error: "没有已下载完成的更新" };
	setImmediate(() => autoUpdater.quitAndInstall(false, true));
	return { ...state };
}

module.exports = {
	init,
	check,
	download,
	install,
	status: () => ({ ...state, currentVersion: app.getVersion() }),
};
