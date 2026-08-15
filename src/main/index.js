"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, globalShortcut } = require("electron");
const { paths, ensureDirs } = require("./paths");
const { config } = require("./config");
const { logger } = require("./logger");
const { runChecks } = require("./env-check");
const { install } = require("./installer");
const daemon = require("./daemon");
const memory = require("./memory");
const updater = require("./updater");
const tray = require("./tray");
const quick = require("./quick-capture");

const RENDERER = path.join(__dirname, "..", "renderer");

let mainWindow = null;
let quitting = false;

function send(channel, payload) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(channel, payload);
	}
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1180,
		height: 800,
		minWidth: 900,
		minHeight: 640,
		show: false,
		backgroundColor: "#f8f9fb",
		title: "OpenContext Desktop",
		icon: path.join(__dirname, "..", "..", "build", "icon.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			webviewTag: false,
		},
	});

	mainWindow.once("ready-to-show", () => mainWindow.show());
	/** Closing the window keeps the local service alive behind the tray icon. */
	mainWindow.on("close", (event) => {
		const settings = config.settings;
		/** Without a live tray icon hiding would leave no way back in. */
		if (quitting || !settings.closeToTray || !tray.isActive()) return;
		event.preventDefault();
		mainWindow.hide();
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	loadInitialView();
}

function loadInitialView() {
	const state = config.get();
	const view = state.installed ? "dashboard.html" : "setup.html";
	mainWindow.loadFile(path.join(RENDERER, view));
}

function showMain() {
	if (!mainWindow || mainWindow.isDestroyed()) {
		createWindow();
		return;
	}
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

function applyLaunchAtLogin() {
	if (!app.isPackaged) return;
	app.setLoginItemSettings({ openAtLogin: Boolean(config.settings.launchAtLogin), args: ["--hidden"] });
}

function applyHotkey() {
	globalShortcut.unregisterAll();
	const accelerator = config.settings.quickCaptureHotkey?.trim();
	if (!accelerator) return { ok: true, registered: false };
	try {
		const ok = globalShortcut.register(accelerator, () => quick.toggle());
		if (!ok) logger.warn("hotkey", `快捷键被其他软件占用：${accelerator}`);
		return { ok, registered: ok };
	} catch (error) {
		logger.warn("hotkey", `快捷键无效：${accelerator}（${error.message}）`);
		return { ok: false, registered: false };
	}
}

function applyTray() {
	if (config.settings.trayEnabled) tray.init({ showMain, checkUpdate: () => updater.check(), quit: () => app.quit() });
	else tray.destroy();
}

function buildMenu() {
	const template = [
		{
			label: "OpenContext",
			submenu: [
				{
					label: "快速记一条",
					click: () => quick.show(),
				},
				{
					label: "检查更新",
					click: () => updater.check(),
				},
				{
					label: "打开数据目录",
					click: () => shell.openPath(paths.root),
				},
				{ type: "separator" },
				{ role: "quit", label: "退出" },
			],
		},
		{
			label: "服务",
			submenu: [
				{ label: "启动", click: () => daemon.start() },
				{ label: "停止", click: () => daemon.stop() },
				{ label: "重启", click: () => daemon.restart() },
			],
		},
		{
			label: "视图",
			submenu: [
				{ role: "reload", label: "刷新" },
				{ role: "toggleDevTools", label: "开发者工具" },
				{ type: "separator" },
				{ role: "zoomIn", label: "放大" },
				{ role: "zoomOut", label: "缩小" },
				{ role: "resetZoom", label: "重置缩放" },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
	ipcMain.handle("app:info", () => ({
		appVersion: app.getVersion(),
		electronVersion: process.versions.electron,
		nodeVersion: process.versions.node,
		platform: `${process.platform}-${process.arch}`,
		packaged: app.isPackaged,
		paths: {
			root: paths.root,
			serverDir: paths.serverDir,
			dataDir: paths.dataDir,
			logsDir: paths.logsDir,
			dbFile: paths.dbFile,
		},
		config: config.get(),
		daemon: daemon.status(),
		updater: updater.status(),
	}));

	ipcMain.handle("env:check", () => runChecks());

	ipcMain.handle("install:start", async () => {
		const result = await install((progress) => send("install:progress", progress));
		if (result.ok) send("install:done", result);
		return result;
	});

	ipcMain.handle("install:finish", async () => {
		if (config.settings.autoStartDaemon) await daemon.start();
		loadInitialView();
		return { ok: true };
	});

	ipcMain.handle("daemon:start", () => daemon.start());
	ipcMain.handle("daemon:stop", () => daemon.stop());
	ipcMain.handle("daemon:restart", () => daemon.restart());
	ipcMain.handle("daemon:status", () => daemon.status());
	ipcMain.handle("daemon:logs", () => daemon.logs());
	ipcMain.handle("daemon:request", (_event, payload) =>
		daemon.apiRequest(payload).catch((error) => ({ ok: false, status: 0, body: { error: error.message } })),
	);

	ipcMain.handle("memory:save", (_event, payload) => memory.save(payload ?? {}));
	ipcMain.handle("memory:search", (_event, payload) => memory.search(payload ?? {}));
	ipcMain.handle("memory:recent", (_event, limit) => memory.recent(limit));
	ipcMain.handle("memory:count", () => memory.count());
	ipcMain.handle("memory:delete", async (_event, id) => {
		const result = await memory.remove(id);
		send("memory:changed", { reason: "delete", id });
		return result;
	});
	ipcMain.handle("memory:restore", async (_event, id) => {
		const result = await memory.restore(id);
		send("memory:changed", { reason: "restore", id });
		return result;
	});
	ipcMain.handle("memory:export", (_event, format) => exportNotes(format));

	ipcMain.handle("settings:get", () => config.settings);
	ipcMain.handle("settings:save", async (_event, patch) => {
		const next = config.patchSettings(patch);
		logger.info("settings", `已更新：${Object.keys(patch ?? {}).join(", ")}`);
		applyTray();
		applyHotkey();
		applyLaunchAtLogin();
		return next;
	});

	ipcMain.handle("runtime:reinstall", async () => {
		await daemon.stop();
		config.patch({ installed: false, runtimeVersion: null });
		loadInitialView();
		return { ok: true };
	});

	ipcMain.handle("update:check", () => updater.check());
	ipcMain.handle("update:download", () => updater.download());
	ipcMain.handle("update:install", () => updater.install());

	ipcMain.handle("quick:show", () => quick.show());
	ipcMain.handle("quick:hide", () => {
		quick.hide();
		send("memory:changed", { reason: "quick" });
	});
	ipcMain.handle("clipboard:write", (_event, text) => clipboard.writeText(String(text ?? "")));

	ipcMain.handle("shell:openPath", (_event, target) => shell.openPath(target));
	ipcMain.handle("shell:openExternal", (_event, url) => shell.openExternal(url));
	ipcMain.handle("app:logs", () => logger.history());
}

/** One-click backup: everything the user wrote, as Markdown or JSON. */
async function exportNotes(format = "md") {
	const items = await memory.all();
	const stamp = new Date().toISOString().slice(0, 10);
	const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
		title: "导出备份",
		defaultPath: path.join(app.getPath("documents"), `opencontext-${stamp}.${format === "json" ? "json" : "md"}`),
		filters:
			format === "json"
				? [{ name: "JSON", extensions: ["json"] }]
				: [{ name: "Markdown", extensions: ["md", "txt"] }],
	});
	if (canceled || !filePath) return { ok: false, canceled: true, total: items.length };

	const body =
		format === "json"
			? `${JSON.stringify({ exportedAt: Date.now(), userId: memory.userId(), items }, null, 2)}\n`
			: [
					`# OpenContext 备份（${stamp}）`,
					"",
					...items.map(
						(item) => `## ${new Date(Number(item.ts)).toLocaleString()}\n\n${item.content}\n`,
					),
			  ].join("\n");
	fs.writeFileSync(filePath, body, "utf8");
	logger.info("export", `已导出 ${items.length} 条到 ${filePath}`);
	return { ok: true, filePath, total: items.length };
}

function singleInstance() {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return false;
	}
	app.on("second-instance", () => showMain());
	return true;
}

if (singleInstance()) {
	app.whenReady().then(async () => {
		ensureDirs();
		logger.info("app", `OpenContext Desktop ${app.getVersion()} 启动，数据目录 ${paths.root}`);
		registerIpc();
		buildMenu();

		daemon.emitter.on("status", (status) => send("daemon:status", status));
		daemon.emitter.on("log", (entry) => send("daemon:log", entry));
		logger.onEntry((entry) => send("app:log", entry));
		updater.init((status) => send("update:status", status));

		quick.setFallback(() => showMain());

		applyTray();
		/** Starting hidden only makes sense when the tray icon really exists. */
		const hidden = process.argv.includes("--hidden") && tray.isActive();
		if (!hidden) createWindow();
		applyHotkey();
		applyLaunchAtLogin();

		const state = config.get();
		if (state.installed && config.settings.autoStartDaemon) {
			daemon.start().catch((error) => logger.error("daemon", error.message));
		}

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});

	app.on("window-all-closed", () => {
		/** With a tray icon the app is expected to keep serving in the background. */
		if (process.platform !== "darwin" && !tray.isActive()) app.quit();
	});

	app.on("before-quit", async (event) => {
		if (quitting) return;
		quitting = true;
		event.preventDefault();
		globalShortcut.unregisterAll();
		quick.destroy();
		await daemon.stop().catch(() => {});
		app.exit(0);
	});

	process.on("uncaughtException", (error) => {
		logger.error("app", error.stack ?? error.message);
		if (app.isReady()) {
			dialog.showErrorBox("OpenContext Desktop 出错了", error.stack ?? error.message);
		}
	});
}
