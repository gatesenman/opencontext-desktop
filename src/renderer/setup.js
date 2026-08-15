"use strict";

const api = window.opencontext;
const $ = (selector) => document.querySelector(selector);

const checklist = $("#checklist");
const logBox = $("#log");

/** Weight of each install step inside the single overall progress bar. */
const STEP_WEIGHT = { node: 0.35, deps: 0.5, verify: 0.15 };
const STEP_ORDER = ["node", "deps", "verify"];

/** Plain-language stage text, so the main line never shows raw npm output. */
const STEP_TEXT = {
	node: "正在准备运行环境…",
	deps: "正在安装 OpenContext…",
	verify: "正在做最后检查…",
};

function appendLog(text) {
	const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
	logBox.textContent += `${text}\n`;
	if (atBottom) logBox.scrollTop = logBox.scrollHeight;
}

function setState(dot, text, stage) {
	$("#stateDot").className = `dot ${dot}`;
	$("#stateText").textContent = text;
	if (stage !== undefined) $("#stageText").textContent = stage;
}

function renderChecks(summary) {
	checklist.innerHTML = "";
	for (const item of summary.results) {
		const li = document.createElement("li");
		const dot = document.createElement("span");
		dot.className = `dot ${item.status}`;
		const label = document.createElement("span");
		label.className = "label";
		label.textContent = item.label;
		const detail = document.createElement("span");
		detail.className = "muted mono";
		detail.textContent = item.detail ?? "";
		li.append(dot, label, detail);
		checklist.append(li);
	}

	const installBtn = $("#install");
	const enterBtn = $("#enter");
	installBtn.disabled = summary.blocked;
	installBtn.hidden = !summary.needsInstall && !summary.blocked;
	installBtn.textContent = summary.needsInstall ? "一键安装并开始使用" : "重新安装运行环境";
	enterBtn.hidden = summary.needsInstall || summary.blocked;

	if (summary.blocked) {
		const bad = summary.results.find((item) => item.status === "fail");
		setState("fail", "有一项检查没通过，暂时无法自动安装", bad ? `${bad.label}：${bad.detail}` : "");
		$("#checkDetails").open = true;
	} else if (summary.needsInstall) {
		setState("warn", "环境还没装好，点下面的按钮开始", "安装大约需要 1–3 分钟，取决于网络速度。");
	} else {
		setState("ok", "环境已就绪", "点“开始使用”进入主界面。");
	}
}

async function refresh() {
	checklist.innerHTML = '<li><span class="dot busy"></span><span class="label">正在检查…</span></li>';
	const summary = await api.checkEnvironment();
	renderChecks(summary);
	return summary;
}

function markStep(step, status, percent, message) {
	const node = document.querySelector(`.step[data-step="${step}"]`);
	if (!node) return;
	node.querySelector(".dot").className = `dot ${status === "running" ? "busy" : status}`;
	node.querySelector("[data-msg]").textContent = message ?? "";
	node.querySelector(".bar > i").style.width = `${percent ?? 0}%`;
}

function updateTotal(step, percent) {
	const index = STEP_ORDER.indexOf(step);
	if (index === -1) return;
	const done = STEP_ORDER.slice(0, index).reduce((sum, key) => sum + STEP_WEIGHT[key], 0);
	const total = (done + (STEP_WEIGHT[step] * (percent ?? 0)) / 100) * 100;
	$("#totalBar").style.width = `${Math.min(100, Math.round(total))}%`;
}

api.on.installProgress((progress) => {
	if (progress.step === "error") {
		appendLog(`✗ ${progress.message}`);
		setState("fail", "安装失败了", `${progress.message}（可以点“重新检查”后再试一次）`);
		$("#progressDetails").open = true;
		$("#install").disabled = false;
		$("#recheck").disabled = false;
		return;
	}
	markStep(progress.step, progress.status, progress.percent, progress.message);
	updateTotal(progress.step, progress.percent);
	setState(
		"busy",
		"正在安装，请不要关闭窗口…",
		STEP_TEXT[progress.step] ?? "正在安装…",
	);
	appendLog(`[${progress.step}] ${progress.message}`);
});

$("#recheck").addEventListener("click", refresh);

$("#install").addEventListener("click", async () => {
	$("#progressDetails").hidden = false;
	logBox.textContent = "";
	$("#install").disabled = true;
	$("#recheck").disabled = true;
	$("#totalBar").style.width = "0%";
	for (const step of STEP_ORDER) markStep(step, "", 0, "等待中");
	setState("busy", "正在安装，请不要关闭窗口…", "正在准备…");

	const result = await api.startInstall();
	$("#recheck").disabled = false;
	if (result.ok) {
		$("#totalBar").style.width = "100%";
		setState("ok", "安装完成，正在进入…", "以后每次打开都会直接进入主界面。");
		appendLog("✓ 安装完成");
		setTimeout(() => api.finishInstall(), 900);
	} else {
		$("#install").disabled = false;
		await refresh();
	}
});

$("#enter").addEventListener("click", () => api.finishInstall());

(async () => {
	const info = await api.appInfo();
	$("#appVersion").textContent = `v${info.appVersion}`;
	$("#dataDir").textContent = `数据保存在：${info.paths.root}`;
	await refresh();
})();
