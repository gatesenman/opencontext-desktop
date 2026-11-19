"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { FALLBACK_NODE_VERSION, nodeArchiveName } = require("../src/main/node-archive");

describe("managed Node archive names", () => {
	it("picks the official tarball or zip for each platform", () => {
		assert.equal(FALLBACK_NODE_VERSION, "v22.23.5");
		const major = Number(/^v?(\d+)/.exec(FALLBACK_NODE_VERSION)[1]);
		assert.ok(major >= 22 && major <= 23);
		assert.equal(
			nodeArchiveName("v22.23.5", { platform: "linux", arch: "x64" }),
			"node-v22.23.5-linux-x64.tar.gz",
		);
		assert.equal(
			nodeArchiveName("v22.23.5", { platform: "linux", arch: "arm64" }),
			"node-v22.23.5-linux-arm64.tar.gz",
		);
		assert.equal(
			nodeArchiveName("v22.23.5", { platform: "darwin", arch: "arm64" }),
			"node-v22.23.5-darwin-arm64.tar.gz",
		);
		assert.equal(
			nodeArchiveName("v22.23.5", { platform: "win32", arch: "x64" }),
			"node-v22.23.5-win-x64.zip",
		);
	});
});
