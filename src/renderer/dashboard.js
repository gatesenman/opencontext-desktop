"use strict";

const api = window.opencontext;
const $ = (selector) => document.querySelector(selector);
const REPO_URL = "https://github.com/gatesenman/opencontext-desktop";

/** Electron wraps IPC failures with a noisy prefix users should never see. */
const reason = (error) =>
	String(error?.message ?? error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");

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

/** Query words worth highlighting in a result: latin words + CJK bigrams. */
function highlightTerms(query) {
	const text = String(query ?? "")
		.toLowerCase()
		.trim();
	if (!text) return [];
	const latin = text.match(/[a-z0-9_]{2,}/g) ?? [];
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) ?? [];
	const grams = [];
	for (const run of cjk) {
		if (run.length === 1) grams.push(run);
		for (let i = 0; i + 2 <= run.length; i += 1) grams.push(run.slice(i, i + 2));
	}
	return [...new Set([...latin, ...grams])].sort((a, b) => b.length - a.length).slice(0, 24);
}

/** Highlights on already escaped text, so user content can never inject markup. */
function highlight(content, terms) {
	let html = escapeHtml(content);
	for (const term of terms) {
		const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		html = html.replace(new RegExp(pattern, "gi"), (match) => `<mark>${match}</mark>`);
	}
	return html;
}

function renderResults(target, items, emptyText, query = "") {
	const box = $(target);
	if (!items || items.length === 0) {
		box.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
		return;
	}
	const terms = highlightTerms(query);
	box.innerHTML = items
		.map(
			(item) => `<article class="result">
				<p>${highlight(item.content, terms)}</p>
				<footer class="muted">
					<span>${escapeHtml(timeAgo(item.ts))}</span>
					${item.score !== undefined ? `<span>匹配度 ${escapeHtml(item.score)}</span>` : ""}
					<button class="link" data-copy="${escapeHtml(item.id)}">复制</button>
					<button class="link danger" data-delete="${escapeHtml(item.id)}">删除</button>
				</footer>
			</article>`,
		)
		.join("");
}

/** One delegated handler covers both the search results and the recent list. */
async function onResultAction(event) {
	const copyId = event.target.dataset?.copy;
	const deleteId = event.target.dataset?.delete;
	if (!copyId && !deleteId) return;
	const card = event.target.closest(".result");
	const text = card?.querySelector("p")?.textContent ?? "";

	if (copyId) {
		await api.clipboard.write(text);
		event.target.textContent = "已复制";
		setTimeout(() => {
			event.target.textContent = "复制";
		}, 1200);
		return;
	}

	event.target.disabled = true;
	try {
		await api.memory.remove(deleteId);
		card?.remove();
		offerUndo(deleteId);
		await refreshRecent();
	} catch (error) {
		$("#listHint").textContent = `删除失败：${reason(error)}`;
		event.target.disabled = false;
	}
}

/** Deleting is one click, so always leave a way back. */
function offerUndo(id) {
	const hint = $("#listHint");
	hint.innerHTML = '已删除一条记录。<button class="link" id="btnUndo">撤销</button>';
	$("#btnUndo").addEventListener("click", async () => {
		$("#btnUndo").disabled = true;
		try {
			await api.memory.restore(id);
			hint.textContent = "已恢复这条记录。";
			await refreshRecent();
		} catch (error) {
			hint.textContent = `恢复失败：${reason(error)}`;
		}
	});
}

async function refreshRecent() {
	try {
		const [items, total] = await Promise.all([api.memory.recent(20), api.memory.count()]);
		$("#totalPill").textContent = `共 ${total} 条`;
		renderResults("#recentList", items, "还没有任何记录，先在上面写一条试试。");
	} catch (error) {
		renderResults("#recentList", [], `读取失败：${reason(error)}`);
	}
}

/** Copy-paste snippets so nobody has to read the API docs to wire a tool up. */
function aiSnippets() {
	const settings = info?.config.settings ?? {};
	const url = daemonStatus.url ?? `http://${settings.host ?? "127.0.0.1"}:${settings.port ?? 7421}`;
	const user = settings.userId ?? "me";
	const body = (payload) => `curl -s ${url}${payload.path} -H "Content-Type: application/json" -d '${JSON.stringify(payload.body)}'`;
	return {
		url,
		search: body({ path: "/v1/search", body: { userId: user, query: "我的偏好", limit: 5 } }),
		write: body({
			path: "/v1/raw-messages",
			body: {
				userId: user,
				embedOnInsert: false,
				messages: [
					{
						messageId: `note-${Date.now()}`,
						userId: user,
						content: "要记住的内容",
						platform: "api",
						botId: "api",
						timestamp: Date.now(),
						createdAt: Date.now(),
					},
				],
			},
		}),
	};
}

async function copyAi(kind, button) {
	const snippets = aiSnippets();
	await api.clipboard.write(snippets[kind]);
	$("#aiHint").textContent = "已复制到剪贴板";
	const original = button.textContent;
	button.textContent = "已复制 ✓";
	setTimeout(() => {
		button.textContent = original;
	}, 1400);
}

async function exportNotes(format, hintTarget) {
	$(hintTarget).textContent = "正在导出…";
	try {
		const result = await api.memory.export(format);
		$(hintTarget).textContent = result.canceled
			? "已取消导出。"
			: `已导出 ${result.total} 条到 ${result.filePath}`;
	} catch (error) {
		$(hintTarget).textContent = `导出失败：${reason(error)}`;
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
	$("#cfTray").checked = settings.trayEnabled;
	$("#cfCloseTray").checked = settings.closeToTray;
	$("#cfLaunch").checked = settings.launchAtLogin;
	$("#cfHotkey").value = settings.quickCaptureHotkey ?? "";
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
		trayEnabled: $("#cfTray").checked,
		closeToTray: $("#cfCloseTray").checked,
		launchAtLogin: $("#cfLaunch").checked,
		quickCaptureHotkey: $("#cfHotkey").value.trim(),
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
		unsupported: ["warn", "无法自动更新"],
	};
	const [dot, text] = map[status.status] ?? ["", status.status];
	$("#upDot").className = `dot ${dot}`;
	$("#upStatus").textContent = text;
	$("#upBar").style.width = `${status.percent ?? 0}%`;
	/** An empty progress bar just looks like a stray line. */
	$("#upBar").parentElement.hidden = status.status !== "downloading";
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
		$("#saveHint").textContent = `没记住：${reason(error)}`;
	} finally {
		button.disabled = false;
	}
});

async function doSearch() {
	const button = $("#btnSearch");
	const query = $("#searchText").value;
	if (!query.trim()) {
		$("#searchMode").textContent = "先在上面的框里写几个关键词。";
		return;
	}
	button.disabled = true;
	$("#searchMode").textContent = "搜索中…";
	try {
		const result = await api.memory.search({ query, limit: 10 });
		$("#searchMode").textContent = result.note ?? "";
		renderResults("#searchResults", result.items, "没找到相关内容，换个词再试，或在设置里打开智能搜索。", query);
	} catch (error) {
		$("#searchMode").textContent = "";
		renderResults("#searchResults", [], `搜索失败：${reason(error)}`);
	} finally {
		button.disabled = false;
	}
}

$("#btnSearch").addEventListener("click", doSearch);
$("#searchText").addEventListener("keydown", (event) => {
	if (event.key === "Enter") doSearch();
});
$("#btnRefreshRecent").addEventListener("click", refreshRecent);
$("#btnQuick").addEventListener("click", () => api.quick.show());
$("#recentList").addEventListener("click", onResultAction);
$("#searchResults").addEventListener("click", onResultAction);
$("#btnExportMd").addEventListener("click", () => exportNotes("md", "#listHint"));
$("#btnExportJson").addEventListener("click", () => exportNotes("json", "#settingsHint"));

$("#btnCopyUrl").addEventListener("click", (event) => copyAi("url", event.target));
$("#btnCopySearch").addEventListener("click", (event) => copyAi("search", event.target));
$("#btnCopyWrite").addEventListener("click", (event) => copyAi("write", event.target));
$("#btnOpenService").addEventListener("click", () => {
	const url = aiSnippets().url;
	if (url) api.openExternal(url);
});

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
api.on.memoryChanged(() => refreshRecent());

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
		$("#hHint").textContent = `界面初始化失败：${reason(error)}`;
	}
})();
