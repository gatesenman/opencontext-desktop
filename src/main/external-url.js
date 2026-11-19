"use strict";

/** Product repo links opened from Help / About. */
const REPO_URL = "https://github.com/gatesenman/opencontext-desktop";

function parseHttpUrl(value) {
	try {
		const url = new URL(String(value ?? "").trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}

function isLoopbackHost(hostname) {
	const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function isRepoUrl(url) {
	if (url.protocol !== "https:") return false;
	if (url.hostname.toLowerCase() !== "github.com") return false;
	const path = url.pathname.replace(/\/+$/, "") || "/";
	return path === "/gatesenman/opencontext-desktop" || path.startsWith("/gatesenman/opencontext-desktop/");
}

/**
 * URLs the desktop shell is allowed to hand to the OS browser.
 * - the GitHub repo (and paths under it)
 * - the local OpenContext daemon / access proxy on loopback
 * - the user-saved embed URL, only if it is a plain http(s) URL
 */
function isAllowedExternalUrl(value, { embedUrl } = {}) {
	const url = parseHttpUrl(value);
	if (!url) return false;
	if (isRepoUrl(url) || isLoopbackHost(url.hostname)) return true;
	const embed = parseHttpUrl(embedUrl);
	return Boolean(embed && embed.href === url.href);
}

module.exports = { REPO_URL, parseHttpUrl, isLoopbackHost, isRepoUrl, isAllowedExternalUrl };
