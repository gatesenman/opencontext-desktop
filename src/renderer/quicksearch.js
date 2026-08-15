"use strict";

const api = window.opencontext;
const $ = (selector) => document.querySelector(selector);

function reason(error) {
	return String(error?.message ?? error ?? "未知错误").replace(/^Error invoking remote method '[^']+': *(Error: *)?/, "");
}

function escapeHtml(value) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);
}

function render(items) {
	const box = $("#qsResults");
	if (!items || items.length === 0) {
		box.innerHTML = '<div class="empty">没有找到，换个关键词试试。</div>';
		return;
	}
	box.innerHTML = "";
	for (const item of items.slice(0, 8)) {
		const card = document.createElement("article");
		card.className = "result";
		card.dataset.raw = item.content ?? "";
		const body = document.createElement("div");
		body.className = "md";
		body.innerHTML = window.renderMarkdown(item.content);
		card.appendChild(body);
		const footer = document.createElement("footer");
		footer.className = "muted";
		footer.innerHTML = `${item.tag ? `<span class="tagpill">${escapeHtml(item.tag)}</span>` : ""}<button class="link" data-copy="1">复制</button>`;
		card.appendChild(footer);
		box.appendChild(card);
	}
}

async function search() {
	const query = $("#qsText").value.trim();
	if (!query) return;
	$("#qsGo").disabled = true;
	$("#qsHint").textContent = "正在搜索…";
	try {
		const result = await api.memory.search({ query, limit: 8 });
		render(result.items);
		$("#qsHint").textContent = result.note ?? "";
	} catch (error) {
		$("#qsHint").textContent = `搜索失败：${reason(error)}`;
	} finally {
		$("#qsGo").disabled = false;
	}
}

$("#qsGo").addEventListener("click", search);
$("#qsResults").addEventListener("click", async (event) => {
	if (!event.target.dataset?.copy) return;
	await api.clipboard.write(event.target.closest(".result")?.dataset.raw ?? "");
	event.target.textContent = "已复制";
	setTimeout(() => {
		event.target.textContent = "复制";
	}, 1200);
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") api.quickSearch.hide();
	if (event.key === "Enter" && event.target.id === "qsText") search();
});

api.on.quickSearchFocus(() => {
	$("#qsHint").textContent = "";
	$("#qsText").select();
	$("#qsText").focus();
});

$("#qsText").focus();
