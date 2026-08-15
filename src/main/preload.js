"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
	return (listener) => {
		const wrapped = (_event, payload) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => ipcRenderer.removeListener(channel, wrapped);
	};
}

contextBridge.exposeInMainWorld("opencontext", {
	appInfo: () => ipcRenderer.invoke("app:info"),
	appLogs: () => ipcRenderer.invoke("app:logs"),
	checkEnvironment: () => ipcRenderer.invoke("env:check"),
	startInstall: () => ipcRenderer.invoke("install:start"),
	finishInstall: () => ipcRenderer.invoke("install:finish"),
	daemon: {
		start: () => ipcRenderer.invoke("daemon:start"),
		stop: () => ipcRenderer.invoke("daemon:stop"),
		restart: () => ipcRenderer.invoke("daemon:restart"),
		status: () => ipcRenderer.invoke("daemon:status"),
		logs: () => ipcRenderer.invoke("daemon:logs"),
		request: (payload) => ipcRenderer.invoke("daemon:request", payload),
	},
	memory: {
		save: (payload) => ipcRenderer.invoke("memory:save", payload),
		search: (payload) => ipcRenderer.invoke("memory:search", payload),
		recent: (limit) => ipcRenderer.invoke("memory:recent", limit),
		count: () => ipcRenderer.invoke("memory:count"),
	},
	settings: {
		get: () => ipcRenderer.invoke("settings:get"),
		save: (patch) => ipcRenderer.invoke("settings:save", patch),
	},
	runtime: {
		reinstall: () => ipcRenderer.invoke("runtime:reinstall"),
	},
	updates: {
		check: () => ipcRenderer.invoke("update:check"),
		download: () => ipcRenderer.invoke("update:download"),
		install: () => ipcRenderer.invoke("update:install"),
	},
	openPath: (target) => ipcRenderer.invoke("shell:openPath", target),
	openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
	on: {
		installProgress: subscribe("install:progress"),
		installDone: subscribe("install:done"),
		daemonStatus: subscribe("daemon:status"),
		daemonLog: subscribe("daemon:log"),
		appLog: subscribe("app:log"),
		updateStatus: subscribe("update:status"),
	},
});
