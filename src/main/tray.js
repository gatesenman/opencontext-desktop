"use strict";

/**
 * Tray entry so the app keeps working like a background helper: the local
 * service stays up and one click is enough to capture or look something up.
 */

const path = require("node:path");
const { Tray, Menu, nativeImage, app } = require("electron");
const daemon = require("./daemon");
const quick = require("./quick-capture");
const logger = require("./logger");

/** Lives under src/ so electron-builder ships it inside the app bundle. */
const ICON = path.join(__dirname, "..", "assets", "tray.png");

const STATUS_TEXT = {
	stopped: "服务已停止",
	starting: "服务启动中…",
	running: "服务运行中",
	error: "服务异常",
};

let tray = null;
let handlers = { showMain: () => {}, checkUpdate: () => {}, quit: () => {} };

function icon() {
	const image = nativeImage.createFromPath(ICON);
	return image.isEmpty() ? image : image.resize({ width: 22, height: 22 });
}

function refresh() {
	if (!tray) return;
	const status = daemon.status();
	const label = STATUS_TEXT[status.status] ?? status.status;
	tray.setToolTip(`OpenContext Desktop — ${label}`);
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "快速记一条…", click: () => quick.show() },
			{ label: "打开主界面", click: () => handlers.showMain() },
			{ type: "separator" },
			{ label: label, enabled: false },
			{
				label: status.status === "running" ? "停止服务" : "启动服务",
				click: () => (status.status === "running" ? daemon.stop() : daemon.start()),
			},
			{ label: "重启服务", click: () => daemon.restart() },
			{ type: "separator" },
			{ label: "检查更新", click: () => handlers.checkUpdate() },
			{ label: "退出", click: () => handlers.quit() },
		]),
	);
}

function init(callbacks) {
	handlers = { ...handlers, ...callbacks };
	if (tray) return tray;
	try {
		tray = new Tray(icon());
	} catch (error) {
		/** No system tray (some Linux desktops): the app must still run. */
		logger.warn("tray", `系统托盘不可用：${error.message}`);
		return null;
	}
	tray.on("click", () => handlers.showMain());
	tray.on("double-click", () => handlers.showMain());
	daemon.emitter.on("status", refresh);
	refresh();
	app.on("before-quit", () => destroy());
	return tray;
}

function destroy() {
	if (tray && !tray.isDestroyed()) tray.destroy();
	tray = null;
}

module.exports = { init, refresh, destroy, isActive: () => Boolean(tray) };
