"use strict";

const api = window.opencontext;
const $ = (selector) => document.querySelector(selector);

/** Electron wraps IPC failures with a noisy prefix users should never see. */
const reason = (error) =>
	String(error?.message ?? error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");

async function save() {
	const text = $("#qText").value.trim();
	if (!text) return;
	$("#qSave").disabled = true;
	$("#qHint").textContent = "正在保存…";
	try {
		await api.memory.save({ text, tag: $("#qTag").value });
		$("#qText").value = "";
		$("#qHint").textContent = "已记住 ✓";
		api.quick.hide();
	} catch (error) {
		$("#qHint").textContent = `没记住：${reason(error)}`;
	} finally {
		$("#qSave").disabled = false;
	}
}

$("#qSave").addEventListener("click", save);
$("#qClose").addEventListener("click", () => api.quick.hide());

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") api.quick.hide();
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) save();
});

api.on.quickFocus(() => {
	$("#qHint").textContent = "";
	$("#qText").focus();
});

$("#qText").focus();
