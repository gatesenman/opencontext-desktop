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

/** Wraps matched terms in <mark> without touching the rendered markup. */
function highlightNode(root, terms) {
	if (terms.length === 0) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
	for (const node of nodes) {
		pattern.lastIndex = 0;
		if (!pattern.test(node.textContent)) continue;
		pattern.lastIndex = 0;
		const span = document.createElement("span");
		span.innerHTML = escapeHtml(node.textContent).replace(pattern, (match) => `<mark>${match}</mark>`);
		node.replaceWith(...span.childNodes);
	}
}

function renderResults(target, items, emptyText, query = "") {
	const box = $(target);
	if (!items || items.length === 0) {
		box.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
		return;
	}
	const terms = highlightTerms(query);
	box.innerHTML = "";
	for (const item of items) {
		const card = document.createElement("article");
		card.className = "result";
		card.dataset.raw = item.content ?? "";
		const body = document.createElement("div");
		body.className = "md";
		body.innerHTML = window.renderMarkdown(item.content);
		highlightNode(body, terms);
		card.appendChild(body);
		const footer = document.createElement("footer");
		footer.className = "muted";
		footer.innerHTML = `
			<span>${escapeHtml(timeAgo(item.ts))}</span>
			${item.tag ? `<span class="tagpill">${escapeHtml(item.tag)}</span>` : ""}
			${item.score !== undefined ? `<span>匹配度 ${escapeHtml(item.score)}</span>` : ""}
			<button class="link" data-open="${escapeHtml(item.id)}">查看</button>
			<button class="link" data-copy="${escapeHtml(item.id)}">复制</button>
			<button class="link danger" data-delete="${escapeHtml(item.id)}">删除</button>`;
		card.appendChild(footer);
		box.appendChild(card);
	}
}

/** One delegated handler covers both the search results and the recent list. */
async function onResultAction(event) {
	const copyId = event.target.dataset?.copy;
	const deleteId = event.target.dataset?.delete;
	const openId = event.target.dataset?.open;
	if (openId) return openDetail(openId);
	if (!copyId && !deleteId) return;
	const card = event.target.closest(".result");
	const text = card?.dataset.raw ?? card?.textContent ?? "";

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
		if ($("#view-library").classList.contains("active")) await loadLibrary();
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
	$("#cfSearchHotkey").value = settings.quickSearchHotkey ?? "";
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
		quickSearchHotkey: $("#cfSearchHotkey").value.trim(),
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
	if (name === "library") refreshLibrary();
	if (name === "ai") refreshAi();
}

/* ── 记忆库 ───────────────────────────────────────── */

const PAGE_SIZE = 20;
const library = { page: 0, total: 0 };

async function loadLibrary() {
	try {
		const { items, total } = await api.memory.browse({
			offset: library.page * PAGE_SIZE,
			limit: PAGE_SIZE,
			tag: $("#libTag").value,
			order: $("#libOrder").value,
		});
		library.total = total;
		const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
		if (library.page >= pages) {
			library.page = pages - 1;
			return loadLibrary();
		}
		renderResults("#libList", items, "这里还没有记录，去首页写一条试试。");
		$("#libPage").textContent = `第 ${library.page + 1} / ${pages} 页 · 共 ${total} 条`;
		$("#libPrev").disabled = library.page === 0;
		$("#libNext").disabled = library.page >= pages - 1;
	} catch (error) {
		renderResults("#libList", [], `读取失败：${reason(error)}`);
	}
}

async function loadTags() {
	try {
		const current = $("#libTag").value;
		const tags = await api.memory.tags();
		$("#libTag").innerHTML =
			'<option value="">全部标签</option>' +
			tags.map((entry) => `<option value="${escapeHtml(entry.tag)}">${escapeHtml(entry.tag)}（${entry.total}）</option>`).join("");
		if ([...$("#libTag").options].some((option) => option.value === current)) $("#libTag").value = current;
	} catch {
		/* tags are decoration; the list still works without them */
	}
}

async function loadStats() {
	try {
		const stats = await api.memory.stats(14);
		$("#stTotal").textContent = stats.total;
		$("#stTags").textContent = stats.byTag.filter((entry) => entry.tag !== "未分类").length;
		$("#stSince").textContent = stats.first ? new Date(stats.first).toLocaleDateString() : "—";

		const byDay = new Map(stats.byDay.map((entry) => [entry.day, entry.total]));
		const days = [];
		for (let i = 13; i >= 0; i -= 1) {
			const date = new Date(Date.now() - i * 86_400_000);
			const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
			days.push({ key, label: `${date.getMonth() + 1}/${date.getDate()}`, total: byDay.get(key) ?? 0 });
		}
		$("#stWeek").textContent = days.slice(-7).reduce((sum, day) => sum + day.total, 0);

		const peak = Math.max(...days.map((day) => day.total), 1);
		$("#dayChart").innerHTML = days
			.map(
				(day) => `<div class="col" title="${day.label}：${day.total} 条">
					<span class="val">${day.total || ""}</span>
					<i style="height:${Math.max((day.total / peak) * 100, day.total > 0 ? 6 : 2)}%"></i>
					<span class="lab">${day.label}</span>
				</div>`,
			)
			.join("");

		const tagPeak = Math.max(...stats.byTag.map((entry) => entry.total), 1);
		$("#tagChart").innerHTML = stats.byTag
			.map(
				(entry) => `<div class="tagrow">
					<span class="name">${escapeHtml(entry.tag)}</span>
					<span class="track"><i style="width:${(entry.total / tagPeak) * 100}%"></i></span>
					<span class="muted">${entry.total}</span>
				</div>`,
			)
			.join("");
		$("#chartHint").textContent = "";
	} catch (error) {
		$("#chartHint").textContent = `统计读取失败：${reason(error)}`;
	}
}

function refreshLibrary() {
	loadStats();
	loadTags();
	loadLibrary();
	loadTrash();
}

/* ── 回收站 ───────────────────────────────── */

async function loadTrash() {
	const box = $("#trashList");
	try {
		const items = await api.memory.trash(100);
		if (!items || items.length === 0) {
			box.innerHTML = '<div class="empty">回收站是空的。</div>';
			$("#trashEmpty").disabled = true;
			return;
		}
		$("#trashEmpty").disabled = false;
		box.innerHTML = "";
		for (const item of items) {
			const card = document.createElement("article");
			card.className = "result";
			card.dataset.raw = item.content ?? "";
			const body = document.createElement("div");
			body.className = "md";
			body.innerHTML = window.renderMarkdown(item.content);
			card.appendChild(body);
			const footer = document.createElement("footer");
			footer.className = "muted";
			footer.innerHTML = `
				<span>删除于 ${escapeHtml(timeAgo(item.deletedAt))}</span>
				${item.tag ? `<span class="tagpill">${escapeHtml(item.tag)}</span>` : ""}
				<button class="link" data-trash-restore="${escapeHtml(item.id)}">恢复</button>
				<button class="link danger" data-trash-purge="${escapeHtml(item.id)}">彻底删除</button>`;
			card.appendChild(footer);
			box.appendChild(card);
		}
	} catch (error) {
		box.innerHTML = `<div class="empty">读取失败：${escapeHtml(reason(error))}</div>`;
	}
}

async function onTrashAction(event) {
	const restoreId = event.target.dataset?.trashRestore;
	const purgeId = event.target.dataset?.trashPurge;
	if (!restoreId && !purgeId) return;
	event.target.disabled = true;
	try {
		if (restoreId) {
			await api.memory.restore(restoreId);
			$("#trashHint").textContent = "已恢复这条记录。";
		} else {
			if (event.target.dataset.confirmed !== "1") {
				event.target.dataset.confirmed = "1";
				event.target.textContent = "再点一次确认";
				event.target.disabled = false;
				return;
			}
			await api.memory.purge(purgeId);
			$("#trashHint").textContent = "已彻底删除。";
		}
		await loadTrash();
		await loadLibrary();
	} catch (error) {
		$("#trashHint").textContent = `操作失败：${reason(error)}`;
		event.target.disabled = false;
	}
}

/* ── 记录详情 / 编辑 ───────────────────────── */

const detail = { id: null, item: null };

function setDetailEditing(editing) {
	$("#detailBody").hidden = editing;
	$("#detailText").hidden = !editing;
	$("#detailTagWrap").hidden = !editing;
	$("#detailEdit").hidden = editing;
	$("#detailSave").hidden = !editing;
	$("#detailCancel").hidden = !editing;
}

async function openDetail(id) {
	try {
		const item = await api.memory.get(id);
		if (!item) throw new Error("记录不存在");
		detail.id = id;
		detail.item = item;
		$("#detailBody").innerHTML = window.renderMarkdown(item.content);
		$("#detailText").value = item.content ?? "";
		$("#detailTag").value = item.tag ?? "";
		$("#detailMeta").textContent = `${item.ts ? new Date(Number(item.ts)).toLocaleString() : ""}${item.tag ? ` · ${item.tag}` : ""}`;
		$("#detailHint").textContent = "";
		setDetailEditing(false);
		$("#detailMask").hidden = false;
	} catch (error) {
		$("#listHint").textContent = `打开失败：${reason(error)}`;
	}
}

function closeDetail() {
	$("#detailMask").hidden = true;
	detail.id = null;
	detail.item = null;
}

/* ── AI 连接（MCP + 令牌） ───────────────────── */

async function loadMcp() {
	try {
		const mcp = await api.access.mcpConfig();
		$("#mcpJson").textContent = mcp.json;
		$("#mcpHint").textContent = mcp.available ? "" : "运行环境还没安装好，配置可能不完整。";
	} catch (error) {
		$("#mcpJson").textContent = `生成失败：${reason(error)}`;
	}
}

async function loadTokens(newToken = null) {
	const box = $("#tokenList");
	try {
		const [tokens, proxy] = await Promise.all([api.access.tokens(), api.access.proxyStatus()]);
		$("#tokenProxyStatus").textContent = proxy.running
			? `令牌接口运行中：${proxy.url}`
			: tokens.length > 0
				? "令牌接口未运行（需要本地服务处于运行中）"
				: "";
		if (tokens.length === 0) {
			box.innerHTML = '<div class="empty">还没有令牌。创建一个后，会开启带鉴权的本地接口。</div>';
			return;
		}
		box.innerHTML = "";
		for (const token of tokens) {
			const isNew = newToken && token.id === newToken.id;
			const card = document.createElement("article");
			card.className = "result";
			const masked = `${token.value.slice(0, 6)}…${token.value.slice(-4)}`;
			card.innerHTML = `
				<div class="row between">
					<strong>${escapeHtml(token.name)}</strong>
					<span class="mono muted">${escapeHtml(isNew ? token.value : masked)}</span>
				</div>
				<footer class="muted">
					<span>创建于 ${escapeHtml(timeAgo(token.createdAt))}</span>
					<span>${token.lastUsedAt ? `最近使用 ${escapeHtml(timeAgo(token.lastUsedAt))}` : "从未使用"}</span>
					<button class="link" data-token-copy="${escapeHtml(token.id)}">复制令牌</button>
					<button class="link danger" data-token-revoke="${escapeHtml(token.id)}">吊销</button>
				</footer>`;
			box.appendChild(card);
		}
		if (newToken) $("#tokenHint").textContent = "已创建，令牌完整显示一次，请及时复制保存。";
	} catch (error) {
		box.innerHTML = `<div class="empty">读取失败：${escapeHtml(reason(error))}</div>`;
	}
}

function refreshAi() {
	loadMcp();
	loadTokens();
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
		$("#notePreview").innerHTML = "";
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

/** 编辑 / 预览切换（记一条） */
$("#noteTabs").addEventListener("click", (event) => {
	const mode = event.target.dataset?.mode;
	if (!mode) return;
	for (const tab of document.querySelectorAll("#noteTabs .tab")) {
		tab.classList.toggle("active", tab.dataset.mode === mode);
	}
	const preview = mode === "preview";
	$("#noteText").hidden = preview;
	$("#notePreview").hidden = !preview;
	if (preview) {
		const text = $("#noteText").value.trim();
		$("#notePreview").innerHTML = text ? window.renderMarkdown(text) : '<span class="muted">先在编辑模式写点内容，再切过来看效果。</span>';
	}
});

$("#libList").addEventListener("click", onResultAction);
$("#libPrev").addEventListener("click", () => {
	library.page = Math.max(library.page - 1, 0);
	loadLibrary();
});
$("#libNext").addEventListener("click", () => {
	library.page += 1;
	loadLibrary();
});
$("#libTag").addEventListener("change", () => {
	library.page = 0;
	loadLibrary();
});
$("#libOrder").addEventListener("change", () => {
	library.page = 0;
	loadLibrary();
});
$("#libRefresh").addEventListener("click", refreshLibrary);

$("#btnSearch").addEventListener("click", doSearch);
$("#searchText").addEventListener("keydown", (event) => {
	if (event.key === "Enter") doSearch();
});
/** 与快速小窗一致：Ctrl+Enter / Cmd+Enter 保存 */
$("#noteText").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) $("#btnSave").click();
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !$("#detailMask").hidden) closeDetail();
});
$("#btnRefreshRecent").addEventListener("click", refreshRecent);
$("#btnQuick").addEventListener("click", () => api.quick.show());
$("#recentList").addEventListener("click", onResultAction);
$("#searchResults").addEventListener("click", onResultAction);
$("#btnExportMd").addEventListener("click", () => exportNotes("md", "#listHint"));
$("#btnExportJson").addEventListener("click", () => exportNotes("json", "#settingsHint"));
$("#btnImportJson").addEventListener("click", async () => {
	$("#settingsHint").textContent = "选择备份文件…";
	try {
		const result = await api.memory.import();
		$("#settingsHint").textContent = result.canceled
			? "已取消导入。"
			: `导入完成：新增 ${result.imported} 条，跳过重复 ${result.skipped} 条。`;
	} catch (error) {
		$("#settingsHint").textContent = `导入失败：${reason(error)}`;
	}
});

$("#btnGoAi").addEventListener("click", () => switchView("ai"));

$("#trashList").addEventListener("click", onTrashAction);
$("#trashRefresh").addEventListener("click", loadTrash);
$("#trashEmpty").addEventListener("click", async (event) => {
	if (event.target.dataset.confirmed !== "1") {
		event.target.dataset.confirmed = "1";
		event.target.textContent = "再点一次确认清空";
		setTimeout(() => {
			event.target.dataset.confirmed = "";
			event.target.textContent = "清空回收站";
		}, 4000);
		return;
	}
	event.target.dataset.confirmed = "";
	event.target.textContent = "清空回收站";
	try {
		const result = await api.memory.purge();
		$("#trashHint").textContent = `已清空，彻底删除 ${result.purged} 条。`;
		await loadTrash();
	} catch (error) {
		$("#trashHint").textContent = `清空失败：${reason(error)}`;
	}
});

$("#detailClose").addEventListener("click", closeDetail);
$("#detailMask").addEventListener("click", (event) => {
	if (event.target.id === "detailMask") closeDetail();
});
$("#detailEdit").addEventListener("click", () => setDetailEditing(true));
$("#detailCancel").addEventListener("click", () => {
	$("#detailText").value = detail.item?.content ?? "";
	$("#detailTag").value = detail.item?.tag ?? "";
	setDetailEditing(false);
});
$("#detailCopy").addEventListener("click", async (event) => {
	await api.clipboard.write(detail.item?.content ?? "");
	event.target.textContent = "已复制";
	setTimeout(() => {
		event.target.textContent = "复制";
	}, 1200);
});
$("#detailSave").addEventListener("click", async () => {
	$("#detailSave").disabled = true;
	$("#detailHint").textContent = "正在保存…";
	try {
		await api.memory.update({ id: detail.id, text: $("#detailText").value, tag: $("#detailTag").value });
		detail.item = { ...detail.item, content: $("#detailText").value.trim(), tag: $("#detailTag").value.trim() };
		$("#detailBody").innerHTML = window.renderMarkdown(detail.item.content);
		$("#detailHint").textContent = "已保存 ✓（保留原记录时间）";
		setDetailEditing(false);
		await refreshRecent();
		if ($("#view-library").classList.contains("active")) await loadLibrary();
	} catch (error) {
		$("#detailHint").textContent = `保存失败：${reason(error)}`;
	} finally {
		$("#detailSave").disabled = false;
	}
});

$("#btnCopyMcp").addEventListener("click", async (event) => {
	await api.clipboard.write($("#mcpJson").textContent);
	event.target.textContent = "已复制 ✓";
	setTimeout(() => {
		event.target.textContent = "复制 MCP 配置";
	}, 1400);
});
$("#btnRefreshMcp").addEventListener("click", loadMcp);
$("#btnCreateToken").addEventListener("click", async () => {
	$("#btnCreateToken").disabled = true;
	try {
		const token = await api.access.createToken($("#tokenName").value);
		$("#tokenName").value = "";
		await loadTokens(token);
	} catch (error) {
		$("#tokenHint").textContent = `创建失败：${reason(error)}`;
	} finally {
		$("#btnCreateToken").disabled = false;
	}
});
$("#tokenList").addEventListener("click", async (event) => {
	const copyId = event.target.dataset?.tokenCopy;
	const revokeId = event.target.dataset?.tokenRevoke;
	if (copyId) {
		const tokens = await api.access.tokens();
		const token = tokens.find((entry) => entry.id === copyId);
		if (token) await api.clipboard.write(token.value);
		event.target.textContent = "已复制";
		setTimeout(() => {
			event.target.textContent = "复制令牌";
		}, 1200);
		return;
	}
	if (revokeId) {
		if (event.target.dataset.confirmed !== "1") {
			event.target.dataset.confirmed = "1";
			event.target.textContent = "再点一次确认";
			return;
		}
		await api.access.revokeToken(revokeId);
		$("#tokenHint").textContent = "已吊销。";
		await loadTokens();
	}
});

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
api.on.memoryChanged(() => {
	refreshRecent();
	if ($("#view-library").classList.contains("active")) refreshLibrary();
});

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
