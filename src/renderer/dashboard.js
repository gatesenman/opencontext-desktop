"use strict";

const api = window.opencontext;
const $ = (selector) => document.querySelector(selector);
const REPO_URL = "https://github.com/gatesenman/opencontext-desktop";

let info = null;
let daemonStatus = { status: "stopped" };

const STATUS_TEXT = {
	stopped: "已停止",
	starting: "启动中",
	running: "运行中",
	error: "异常",
};

const STATUS_DOT = {
	stopped: "",
	starting: "busy",
	running: "ok",
	error: "fail",
};

/** Plain-language banner copy for the home view. */
const BANNER = {
	running: ["一切正常，可以开始使用", "本地服务已启动，记录和搜索都保存在这台电脑上。"],
	starting: ["服务正在启动…", "第一次启动通常几秒钟，请稍等。"],
	stopped: ["服务没有运行", "点右边的“启动服务”，就能继续记录和搜索。"],
	error: ["服务启动失败", "点“启动服务”重试；如果一直失败，可在“高级功能 → 运行日志”查看原因。"],
};

function escapeHtml(value) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);
}

function timeAgo(ts) {
	if (!ts) return "";
	const diff = Date.now() - Number(ts);
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(Number(ts)).toLocaleDateString();
}

function writeOut(target, value) {
	const box = $(target);
	box.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	box.scrollTop = 0;
}

function appendLogLine(box, entry) {
	const stamp = new Date(entry.ts).toLocaleTimeString();
	const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
	box.textContent += `${stamp} ${entry.scope ? `[${entry.scope}] ` : ""}${entry.text ?? entry.message}\n`;
	if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ── rendering ──────────────────────────────────────────── */

function renderStatus(status) {
	daemonStatus = status;
	const text = STATUS_TEXT[status.status] ?? status.status;
	const dot = STATUS_DOT[status.status] ?? "";
	const [title, hint] = BANNER[status.status] ?? [text, ""];

	$("#sideStatus").textContent = text;
	$("#sideDot").className = `dot ${dot}`;
	$("#sideUrl").textContent = status.url ?? "";

	$("#hDot").className = `dot big ${dot}`;
	$("#hTitle").textContent = title;
	$("#hHint").textContent = status.status === "error" && status.lastError ? `${hint}（${status.lastError}）` : hint;
	$("#hFix").hidden = status.status === "running" || status.status === "starting";
	$("#banner").classList.toggle("bad", status.status === "error");

	$("#ovStatus").textContent = text;
	$("#ovDot").className = `dot ${dot}`;
	$("#ovUrl").textContent = status.url ?? "";
	$("#ovError").textContent = status.lastError ?? "";
	$("#btnStart").disabled = status.status === "running" || status.status === "starting";
	$("#btnStop").disabled = status.status !== "running";

	const rows = [
		["服务地址", status.url ?? "—"],
		["进程 PID", status.pid ?? "—"],
		["启动时间", status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"],
		["运行时版本", status.runtimeVersion ?? "—"],
		["Node.js", info ? `${info.config.nodeVersion ?? "—"}（${info.config.nodeSource ?? "—"}）` : "—"],
		["数据库", info?.paths.dbFile ?? "—"],
	];
	const html = rows.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join("");
	$("#hDetail").innerHTML = html;
	$("#ovInfo").innerHTML = html;
}

function renderResults(target, items, emptyText) {
	const box = $(target);
	if (!items || items.length === 0) {
		box.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
		return;
	}
	box.innerHTML = items
		.map(
			(item) => `<article class="result">
				<p>${escapeHtml(item.content)}</p>
				<footer class="muted">
					<span>${escapeHtml(timeAgo(item.ts))}</span>
					${item.score !== undefined ? `<span>匹配度 ${escapeHtml(item.score)}</span>` : ""}
					<span class="mono">${escapeHtml(item.id)}</span>
				</footer>
			</article>`,
		)
		.join("");
}

async function refreshRecent() {
	try {
		const [items, total] = await Promise.all([api.memory.recent(20), api.memory.count()]);
		$("#totalPill").textContent = `共 ${total} 条`;
		renderResults("#recentList", items, "还没有任何记录，先在上面写一条试试。");
	} catch (error) {
		renderResults("#recentList", [], `读取失败：${error.message}`);
	}
}

function renderSettings(settings) {
	$("#cfUser").value = settings.userId;
	$("#cfHost").value = settings.host;
	$("#cfPort").value = settings.port;
	$("#cfEmbedding").value = settings.embeddingProvider;
	$("#cfMemory").value = settings.memoryBackend;
	$("#cfInsights").value = settings.insightsBackend;
	$("#cfKnowledge").value = settings.knowledgeBackend;
	$("#cfChroma").value = settings.chromaUrl;
	$("#cfEmbedModel").value = settings.embeddingModel;
	$("#cfRegistry").value = settings.npmRegistry;
	$("#cfNodeMirror").value = settings.nodeMirror;
	$("#cfChannel").value = settings.runtimeChannel;
	$("#cfEmbedUrl").value = settings.embeddedUrl;
	$("#cfAutoStart").checked = settings.autoStartDaemon;
	$("#cfAutoUpdate").checked = settings.autoCheckUpdates;
	$("#mUser").value = settings.userId;
}

function collectSettings() {
	return {
		userId: $("#cfUser").value.trim() || "me",
		host: $("#cfHost").value.trim() || "127.0.0.1",
		port: Number($("#cfPort").value) || 7421,
		embeddingProvider: $("#cfEmbedding").value,
		memoryBackend: $("#cfMemory").value,
		insightsBackend: $("#cfInsights").value,
		knowledgeBackend: $("#cfKnowledge").value,
		chromaUrl: $("#cfChroma").value.trim(),
		embeddingModel: $("#cfEmbedModel").value.trim(),
		npmRegistry: $("#cfRegistry").value.trim(),
		nodeMirror: $("#cfNodeMirror").value.trim() || "https://nodejs.org/dist",
		runtimeChannel: $("#cfChannel").value.trim() || "latest",
		embeddedUrl: $("#cfEmbedUrl").value.trim(),
		autoStartDaemon: $("#cfAutoStart").checked,
		autoCheckUpdates: $("#cfAutoUpdate").checked,
	};
}

function renderUpdate(status) {
	const map = {
		idle: ["", "未检查"],
		checking: ["busy", "正在检查更新"],
		available: ["warn", `发现新版本 ${status.version ?? ""}`],
		downloading: ["busy", `下载中 ${status.percent ?? 0}%`],
		ready: ["ok", `已下载 ${status.version ?? ""}，可安装`],
		"not-available": ["ok", "已是最新版本"],
		error: ["fail", "检查更新失败"],
		unsupported: ["", "开发模式不检查更新"],
	};
	const [dot, text] = map[status.status] ?? ["", status.status];
	$("#upDot").className = `dot ${dot}`;
	$("#upStatus").textContent = text;
	$("#upBar").style.width = `${status.percent ?? 0}%`;
	$("#upDetail").textContent = status.error ?? "";
	$("#btnDownloadUpdate").hidden = status.status !== "available";
	$("#btnInstallUpdate").hidden = status.status !== "ready";
}

function renderAbout() {
	const rows = [
		["桌面端版本", info.appVersion],
		["Electron", info.electronVersion],
		["平台", info.platform],
		["运行时包版本", info.config.runtimeVersion ?? "—"],
		["数据目录", info.paths.root],
	];
	$("#aboutInfo").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function switchView(name) {
	for (const node of document.querySelectorAll(".view")) {
		node.classList.toggle("active", node.id === `view-${name}`);
	}
	for (const node of document.querySelectorAll(".nav")) {
		node.classList.toggle("active", node.dataset.view === name);
	}
	if (name === "embed") loadEmbed();
	if (name === "home") refreshRecent();
}

function embedTarget() {
	return $("#eUrl").value.trim() || info.config.settings.embeddedUrl || daemonStatus.url || "";
}

function loadEmbed() {
	const url = embedTarget();
	if (!$("#eUrl").value.trim()) $("#eUrl").value = url;
	$("#embedFrame").src = url || "about:blank";
}

const request = (payload) => api.daemon.request(payload);

/* ── wiring：首页 ───────────────────────────────────────── */

for (const node of document.querySelectorAll(".nav[data-view]")) {
	node.addEventListener("click", () => switchView(node.dataset.view));
}

$("#btnAdvanced").addEventListener("click", () => {
	const nav = $("#advNav");
	nav.hidden = !nav.hidden;
	$("#btnAdvanced").textContent = nav.hidden ? "高级功能 ▾" : "高级功能 ▴";
});

$("#hDetailToggle").addEventListener("click", () => {
	$("#hDetail").hidden = !$("#hDetail").hidden;
});
$("#hFix").addEventListener("click", async () => {
	$("#hFix").disabled = true;
	try {
		renderStatus(await api.daemon.restart());
	} finally {
		$("#hFix").disabled = false;
	}
});

$("#btnSave").addEventListener("click", async () => {
	const button = $("#btnSave");
	button.disabled = true;
	$("#saveHint").textContent = "正在保存…";
	try {
		const saved = await api.memory.save({ text: $("#noteText").value, tag: $("#noteTag").value });
		$("#noteText").value = "";
		$("#saveHint").textContent = `已记住 ✓ ${timeAgo(saved.ts)}`;
		await refreshRecent();
	} catch (error) {
		$("#saveHint").textContent = `没记住：${error.message}`;
	} finally {
		button.disabled = false;
	}
});

async function doSearch() {
	const button = $("#btnSearch");
	button.disabled = true;
	$("#searchMode").textContent = "搜索中…";
	try {
		const result = await api.memory.search({ query: $("#searchText").value, limit: 10 });
		$("#searchMode").textContent = result.note ?? "";
		renderResults("#searchResults", result.items, "没找到相关内容，换个词再试，或在设置里打开智能搜索。");
	} catch (error) {
		$("#searchMode").textContent = "";
		renderResults("#searchResults", [], `搜索失败：${error.message}`);
	} finally {
		button.disabled = false;
	}
}

$("#btnSearch").addEventListener("click", doSearch);
$("#searchText").addEventListener("keydown", (event) => {
	if (event.key === "Enter") doSearch();
});
$("#btnRefreshRecent").addEventListener("click", refreshRecent);

/* ── wiring：帮助 / 设置 / 更新 ──────────────────────────── */

$("#btnHelpData").addEventListener("click", () => api.openPath(info.paths.root));
$("#btnHelpLogs").addEventListener("click", () => api.openPath(info.paths.logsDir));
$("#btnHelpRepo").addEventListener("click", () => api.openExternal(REPO_URL));

$("#btnSaveSettings").addEventListener("click", async () => {
	info.config.settings = await api.settings.save(collectSettings()).then((state) => state.settings ?? state);
	$("#settingsHint").textContent = `已保存 ${new Date().toLocaleTimeString()}，重启服务后生效。`;
});
$("#btnSaveRestart").addEventListener("click", async () => {
	await api.settings.save(collectSettings());
	$("#settingsHint").textContent = "已保存，正在重启服务…";
	renderStatus(await api.daemon.restart());
	$("#settingsHint").textContent = `已保存并重启 ${new Date().toLocaleTimeString()}`;
});
$("#btnReinstall").addEventListener("click", () => api.runtime.reinstall());
$("#btnOpenData").addEventListener("click", () => api.openPath(info.paths.root));
$("#btnOpenLogsDir").addEventListener("click", () => api.openPath(info.paths.logsDir));

$("#btnCheckUpdate").addEventListener("click", async () => renderUpdate(await api.updates.check()));
$("#btnDownloadUpdate").addEventListener("click", async () => renderUpdate(await api.updates.download()));
$("#btnInstallUpdate").addEventListener("click", () => api.updates.install());
$("#btnRepo").addEventListener("click", () => api.openExternal(REPO_URL));

/* ── wiring：高级 ───────────────────────────────────────── */

$("#btnStart").addEventListener("click", async () => renderStatus(await api.daemon.start()));
$("#btnStop").addEventListener("click", async () => renderStatus(await api.daemon.stop()));
$("#btnRestart").addEventListener("click", async () => renderStatus(await api.daemon.restart()));
$("#btnHealth").addEventListener("click", async () => {
	writeOut("#ovOut", await request({ method: "GET", path: "/health" }));
});

$("#btnStore").addEventListener("click", async () => {
	const now = Date.now();
	const messageId = $("#mId").value.trim() || `desktop-${now}`;
	const userId = $("#mUser").value.trim();
	const result = await request({
		method: "POST",
		path: "/v1/raw-messages",
		body: {
			userId,
			embedOnInsert: $("#mEmbed").checked,
			messages: [
				{
					messageId,
					userId,
					content: $("#mContent").value,
					platform: $("#mPlatform").value.trim() || "desktop",
					botId: $("#mBot").value.trim() || "desktop",
					timestamp: now,
					createdAt: now,
				},
			],
		},
	});
	writeOut("#apiOut", { messageId, ...result });
	$("#sMessageId").value = messageId;
});

$("#btnSearchApi").addEventListener("click", async () => {
	writeOut(
		"#apiOut",
		await request({
			method: "POST",
			path: "/v1/search",
			body: {
				userId: $("#mUser").value.trim(),
				query: $("#sQuery").value,
				limit: Number($("#sLimit").value) || 5,
			},
		}),
	);
});

$("#btnGetMessage").addEventListener("click", async () => {
	const id = $("#sMessageId").value.trim();
	if (!id) return writeOut("#apiOut", "请先填写 messageId");
	writeOut(
		"#apiOut",
		await request({
			method: "GET",
			path: `/v1/raw-messages/${encodeURIComponent(id)}?userId=${encodeURIComponent($("#mUser").value.trim())}`,
		}),
	);
});

$("#btnLoadEmbed").addEventListener("click", loadEmbed);
$("#btnSaveEmbed").addEventListener("click", async () => {
	await api.settings.save({ embeddedUrl: $("#eUrl").value.trim() });
});
$("#btnOpenBrowser").addEventListener("click", () => {
	const url = embedTarget();
	if (url) api.openExternal(url);
});

$("#btnOpenLogs").addEventListener("click", () => api.openPath(info.paths.logsDir));
$("#btnClearLogs").addEventListener("click", () => {
	$("#logBox").textContent = "";
});

api.on.daemonStatus(renderStatus);
api.on.daemonLog((entry) => appendLogLine($("#logBox"), entry));
api.on.appLog((entry) => appendLogLine($("#logBox"), entry));
api.on.updateStatus(renderUpdate);

(async () => {
	try {
		info = await api.appInfo();
		$("#sideVersion").textContent = `v${info.appVersion}`;
		renderSettings(info.config.settings);
		renderAbout();
		renderStatus(info.daemon);
		renderUpdate(info.updater);
		await refreshRecent();
		for (const entry of await api.daemon.logs()) appendLogLine($("#logBox"), entry);
		setInterval(async () => renderStatus(await api.daemon.status()), 5000);
	} catch (error) {
		$("#hHint").textContent = `界面初始化失败：${error.message}`;
	}
})();
