"use strict";

/**
 * Small always-on-top window for "write it down without stopping what you do":
 * opened from the tray or the global hotkey, hidden again right after saving.
 */

const path = require("node:path");
const { BrowserWindow, screen } = require("electron");
const { config } = require("./config");

const RENDERER = path.join(__dirname, "..", "renderer");

let window = null;

function create() {
	window = new BrowserWindow({
		width: 540,
		height: 252,
		useContentSize: true,
		show: false,
		frame: false,
		resizable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		/** Transparent so the rounded card in quick.html has no square backdrop. */
		transparent: true,
		backgroundColor: "#00000000",
		title: "快速记一条",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	window.setMenuBarVisibility(false);
	window.loadFile(path.join(RENDERER, "quick.html"));
	window.on("blur", () => hide());
	window.on("closed", () => {
		window = null;
	});
	return window;
}

function center() {
	if (!window) return;
	const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
	const [width, height] = window.getSize();
	window.setPosition(
		Math.round(area.x + (area.width - width) / 2),
		Math.round(area.y + Math.max(60, area.height * 0.22)),
	);
}

let onUnavailable = () => {};

function show() {
	/** Before the runtime is installed there is nowhere to write notes yet. */
	if (!config.get().installed) return onUnavailable();
	if (!window || window.isDestroyed()) create();
	center();
	window.show();
	window.focus();
	window.webContents.send("quick:focus");
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
