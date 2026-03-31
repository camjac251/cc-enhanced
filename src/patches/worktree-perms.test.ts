import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { worktreePerms } from "./worktree-perms.js";

describe("worktree-perms patch", () => {
	it("has correct tag", () => {
		assert.equal(worktreePerms.tag, "worktree-perms");
	});

	it("has astPasses", () => {
		assert.ok(worktreePerms.astPasses, "should have astPasses");
	});

	it("has verify", () => {
		assert.ok(worktreePerms.verify, "should have verify");
	});
});
