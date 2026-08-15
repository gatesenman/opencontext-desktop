"use strict";

/**
 * Tiny Markdown renderer shared by the dashboard and the quick-capture window.
 * All input is HTML-escaped before any markup is generated, so user content can
 * never inject tags. Supports: headings, bold, italic, strikethrough, inline
 * code, fenced code blocks, links (http/https only), quotes, lists, and rules.
 */
(() => {
	const escapeHtml = (value) =>
		String(value ?? "").replace(
			/[&<>"']/g,
			(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
		);

	function inline(text) {
		let html = escapeHtml(text);
		html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
		html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
		html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
		html = html.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
			'<a href="$2" target="_blank" rel="noreferrer">$1</a>',
		);
		return html;
	}

	function renderMarkdown(source) {
		const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
		const out = [];
		let list = null; // "ul" | "ol"
		let quote = false;
		let code = false;

		const closeList = () => {
			if (list) out.push(`</${list}>`);
			list = null;
		};
		const closeQuote = () => {
			if (quote) out.push("</blockquote>");
			quote = false;
		};

		for (const line of lines) {
			if (/^```/.test(line.trim())) {
				closeList();
				closeQuote();
				out.push(code ? "</code></pre>" : "<pre><code>");
				code = !code;
				continue;
			}
			if (code) {
				out.push(`${escapeHtml(line)}\n`);
				continue;
			}

			const heading = line.match(/^(#{1,4})\s+(.*)$/);
			if (heading) {
				closeList();
				closeQuote();
				const level = Math.min(heading[1].length + 2, 6);
				out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
				continue;
			}
			if (/^(\s*)([-*+])\s+/.test(line)) {
				closeQuote();
				if (list !== "ul") {
					closeList();
					out.push("<ul>");
					list = "ul";
				}
				out.push(`<li>${inline(line.replace(/^(\s*)([-*+])\s+/, ""))}</li>`);
				continue;
			}
			if (/^\s*\d+[.)]\s+/.test(line)) {
				closeQuote();
				if (list !== "ol") {
					closeList();
					out.push("<ol>");
					list = "ol";
				}
				out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
				continue;
			}
			if (/^>\s?/.test(line)) {
				closeList();
				if (!quote) {
					out.push("<blockquote>");
					quote = true;
				}
				out.push(`<p>${inline(line.replace(/^>\s?/, ""))}</p>`);
				continue;
			}
			if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
				closeList();
				closeQuote();
				out.push("<hr />");
				continue;
			}
			closeList();
			closeQuote();
			if (line.trim() === "") continue;
			out.push(`<p>${inline(line)}</p>`);
		}
		if (code) out.push("</code></pre>");
		closeList();
		closeQuote();
		return out.join("");
	}

	window.renderMarkdown = renderMarkdown;
})();
