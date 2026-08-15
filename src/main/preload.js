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
		remove: (id) => ipcRenderer.invoke("memory:delete", id),
		restore: (id) => ipcRenderer.invoke("memory:restore", id),
		export: (format) => ipcRenderer.invoke("memory:export", format),
		browse: (payload) => ipcRenderer.invoke("memory:browse", payload),
		tags: () => ipcRenderer.invoke("memory:tags"),
		stats: (days) => ipcRenderer.invoke("memory:stats", days),
		get: (id) => ipcRenderer.invoke("memory:get", id),
		update: (payload) => ipcRenderer.invoke("memory:update", payload),
		trash: (limit) => ipcRenderer.invoke("memory:trash", limit),
		purge: (id) => ipcRenderer.invoke("memory:purge", id),
		import: () => ipcRenderer.invoke("memory:import"),
	},
	access: {
		tokens: () => ipcRenderer.invoke("access:tokens"),
		createToken: (name) => ipcRenderer.invoke("access:createToken", name),
		revokeToken: (id) => ipcRenderer.invoke("access:revokeToken", id),
		proxyStatus: () => ipcRenderer.invoke("access:proxyStatus"),
		mcpConfig: () => ipcRenderer.invoke("access:mcpConfig"),
	},
	quick: {
		show: () => ipcRenderer.invoke("quick:show"),
		hide: () => ipcRenderer.invoke("quick:hide"),
	},
	quickSearch: {
		show: () => ipcRenderer.invoke("quicksearch:show"),
		hide: () => ipcRenderer.invoke("quicksearch:hide"),
	},
	clipboard: {
		write: (text) => ipcRenderer.invoke("clipboard:write", text),
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
		quickFocus: subscribe("quick:focus"),
		quickSearchFocus: subscribe("quicksearch:focus"),
		memoryChanged: subscribe("memory:changed"),
	},
});
