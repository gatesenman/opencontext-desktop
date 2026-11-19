"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedExternalUrl, REPO_URL } = require("../src/main/external-url");

describe("openExternal allow list", () => {
	it("allows the product repo, loopback daemon URLs, and the saved embed URL", () => {
		assert.equal(isAllowedExternalUrl(REPO_URL), true);
		assert.equal(isAllowedExternalUrl(`${REPO_URL}/issues/4`), true);
		assert.equal(isAllowedExternalUrl("http://127.0.0.1:7421"), true);
		assert.equal(isAllowedExternalUrl("http://localhost:7421/health"), true);
		assert.equal(isAllowedExternalUrl("http://[::1]:7421"), true);
		assert.equal(
			isAllowedExternalUrl("https://example.com/embed", { embedUrl: "https://example.com/embed" }),
			true,
		);
	});

	it("rejects file, javascript, and unrelated http(s) targets", () => {
		assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
		assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
		assert.equal(isAllowedExternalUrl("https://evil.example/"), false);
		assert.equal(isAllowedExternalUrl("https://github.com/gatesenman/other"), false);
		assert.equal(isAllowedExternalUrl("https://github.com.evil.example/gatesenman/opencontext-desktop"), false);
		assert.equal(
			isAllowedExternalUrl("https://evil.example/", { embedUrl: "https://example.com/embed" }),
			false,
		);
		assert.equal(isAllowedExternalUrl("https://user:pass@127.0.0.1:7421"), false);
	});
});
