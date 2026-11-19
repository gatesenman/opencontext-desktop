"use strict";

/** Newest LTS we fall back to when the version index cannot be fetched. */
const FALLBACK_NODE_VERSION = "v22.23.5";

function nodeArchiveName(version, { platform = process.platform, arch = process.arch } = {}) {
	const cpu = arch === "arm64" ? "arm64" : "x64";
	if (platform === "win32") return `node-${version}-win-${cpu}.zip`;
	const osName = platform === "darwin" ? "darwin" : "linux";
	return `node-${version}-${osName}-${cpu}.tar.gz`;
}

module.exports = { FALLBACK_NODE_VERSION, nodeArchiveName };
