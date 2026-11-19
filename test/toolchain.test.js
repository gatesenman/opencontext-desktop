"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
	MIN_NODE_MAJOR,
	MAX_NODE_MAJOR,
	parseMajor,
	isSupportedNode,
	toolchainEnv,
	resolveToolchain,
} = require("../src/main/toolchain");

describe("Node runtime gate", () => {
	it("accepts only majors 22 and 23", () => {
		assert.equal(MIN_NODE_MAJOR, 22);
		assert.equal(MAX_NODE_MAJOR, 23);
		assert.equal(parseMajor("v20.19.0"), 20);
		assert.equal(parseMajor("22.11.0"), 22);
		assert.equal(parseMajor("not-a-version"), 0);
		assert.equal(isSupportedNode("v20.19.5"), false);
		assert.equal(isSupportedNode("v21.7.3"), false);
		assert.equal(isSupportedNode("v22.23.5"), true);
		assert.equal(isSupportedNode("v23.11.0"), true);
		assert.equal(isSupportedNode("v24.22.1"), false);
	});

	it("puts an absolute node binary first on PATH", () => {
		const env = toolchainEnv({ nodePath: "/tmp/managed-node/bin/node" }, { PATH: "/usr/bin" });
		assert.equal(env.PATH, ["/tmp/managed-node/bin", "/usr/bin"].join(path.delimiter));
		assert.deepEqual(toolchainEnv({ nodePath: "node" }, { PATH: "/usr/bin" }), {});
	});

	it("does not treat the host Node.js 24 as a usable runtime when no managed 22–23 is present", async () => {
		const Module = require("module");
		const original = Module._load;
		const root = "/tmp/ocd-toolchain-test-no-runtime";
		Module._load = function mock(request, parent, isMain) {
			if (request === "electron") {
				return { app: { getPath: () => root } };
			}
			return original.call(this, request, parent, isMain);
		};
		try {
			// Re-require paths/toolchain would be cached; resolveToolchain already
			// loaded toolchain. It calls getPaths() lazily, so the mock must be
			// in place before the first paths require.
			delete require.cache[require.resolve("../src/main/paths")];
			const result = await resolveToolchain();
			const hostMajor = parseMajor(process.version);
			if (result.ok) {
				assert.equal(isSupportedNode(result.nodeVersion), true);
				assert.ok(["managed", "system"].includes(result.source));
				// A supported binary may exist elsewhere on this machine; the host
				// interpreter itself is out of range and must not be selected as-is.
				if (hostMajor < MIN_NODE_MAJOR || hostMajor > MAX_NODE_MAJOR) {
					assert.notEqual(parseMajor(result.nodeVersion), hostMajor);
				}
			} else {
				assert.equal(result.nodePath, null);
				assert.equal(result.source, null);
			}
		} finally {
			Module._load = original;
		}
	});
});
