"use strict";

/**
 * Always-on-top companion of the quick capture window, but for finding notes:
 * opened from the tray or the global hotkey, Esc hides it again.
 */

const path = require("node:path");
const { BrowserWindow, screen } = require("electron");
const { config } = require("./config");

const RENDERER = path.join(__dirname, "..", "renderer");

let window = null;

function create() {
	window = new BrowserWindow({
		width: 620,
		height: 420,
		useContentSize: true,
		show: false,
		frame: false,
		resizable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		transparent: true,
		backgroundColor: "#00000000",
		title: "查询记忆",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	window.setMenuBarVisibility(false);
	window.loadFile(path.join(RENDERER, "quicksearch.html"));
	window.on("blur", () => hide());
	window.on("closed", () => {
		window = null;
	});
	return window;
}

function center() {
	if (!window) return;
	const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const [width] = window.getSize();
	window.setPosition(
		Math.round(area.x + (area.width - width) / 2),
		Math.round(area.y + Math.max(60, area.height * 0.16)),
	);
}

let onUnavailable = () => {};

function show() {
	if (!config.get().installed) return onUnavailable();
	if (!window || window.isDestroyed()) create();
	center();
	window.show();
	window.focus();
	window.webContents.send("quicksearch:focus");
}

function hide() {
	if (window && !window.isDestroyed() && window.isVisible()) window.hide();
}

function toggle() {
	if (window && !window.isDestroyed() && window.isVisible()) hide();
	else show();
}

function destroy() {
	if (window && !window.isDestroyed()) window.destroy();
	window = null;
}

module.exports = {
	show,
	hide,
	toggle,
	destroy,
	setFallback: (handler) => {
		onUnavailable = handler;
	},
};
