import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allPatches } from "../patches/index.js";
import { verifyCliAnchors } from "./verify-cli-anchors.js";

test("verifyCliAnchors reports input failures for unreadable files", async () => {
	const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const patchedCliPath = path.join(os.tmpdir(), `missing-patched-${nonce}.js`);
	const cleanCliPath = path.join(os.tmpdir(), `missing-clean-${nonce}.js`);

	const result = await verifyCliAnchors({ patchedCliPath, cleanCliPath });
	assert.equal(result.ok, false);
	assert.ok(
		result.failures.some(
			(failure) =>
				failure.scope === "input" &&
				failure.id === "input-patched-not-readable",
		),
	);
	assert.ok(
		result.failures.some(
			(failure) =>
				failure.scope === "input" && failure.id === "input-clean-not-readable",
		),
	);
});

test("verifyCliAnchors skips input failures when both files are readable", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "anchor-verify-test-"),
	);
	const patchedCliPath = path.join(tempDir, "patched-cli.js");
	const cleanCliPath = path.join(tempDir, "clean-cli.js");
	try {
		await fs.writeFile(patchedCliPath, "const marker = 1;", "utf-8");
		await fs.writeFile(cleanCliPath, "const marker = 2;", "utf-8");

		const result = await verifyCliAnchors({ patchedCliPath, cleanCliPath });
		assert.equal(
			result.failures.some((failure) => failure.scope === "input"),
			false,
		);
		assert.equal(result.ok, false);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyCliAnchors can skip duplicate per-patch verifier pass", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "anchor-verify-skip-patch-verify-"),
	);
	const patchedCliPath = path.join(tempDir, "patched-cli.js");
	const cleanCliPath = path.join(tempDir, "clean-cli.js");
	try {
		await fs.writeFile(patchedCliPath, "const marker = 1;", "utf-8");
		await fs.writeFile(cleanCliPath, "const marker = 2;", "utf-8");

		const fullResult = await verifyCliAnchors({ patchedCliPath, cleanCliPath });
		const fastResult = await verifyCliAnchors({
			patchedCliPath,
			cleanCliPath,
			skipPatchVerifiers: true,
		});

		assert.equal(
			fullResult.failures.some((failure) => failure.scope === "patch-verify"),
			true,
		);
		assert.equal(
			fastResult.failures.some((failure) => failure.scope === "patch-verify"),
			false,
		);
		assert.equal(fastResult.checksRun < fullResult.checksRun, true);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyCliAnchors passes when patched fixture satisfies required anchors", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "anchor-verify-positive-"),
	);
	const patchedCliPath = path.join(tempDir, "patched-cli.js");
	const cleanCliPath = path.join(tempDir, "clean-cli.js");
	const selectedTags = allPatches
		.map((patch) => patch.tag)
		.filter((tag) => tag !== "signature")
		.sort();
	const signature = `(Claude Code; patched: ${selectedTags.join(", ")})`;
	const patchedFixture = [
		"Always use gh api for GitHub URLs, not web fetching tools.",
		"Always use bat to view files, not cat/head/tail.",
		"Always use sg for code search, rg only for text/logs/config. Prefer sg over rg.",
		"Never use cat/echo/printf for file writes - use Write or Edit tools.",
		'allowedTools: ["Read", "Bash"]',
		"**Common tool matchers:** `Bash`, `Write`, `Edit`, `Read`, `Agent`",
		"Line range using supported bat-style forms",
		"Range parameter (for text files only, supported bat-style forms):",
		'args.push("-r", normalizedRange)',
		"[TRUNCATED - changed-file diff head+tail summary]",
		"The instructions above are MANDATORY when they apply to your current task. Follow them exactly as written.",
		"Never use grep/find/ls/sed - use rg/fd/eza/sd instead.",
		"Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes",
		"CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE",
		"ENABLE_SESSION_MEMORY",
		'return "patched";',
		"if (A.offset !== void 0 || A.limit !== void 0 || A.range !== void 0) return null;",
		'if (typeof A?.file_path === "string" && A.offset === void 0 && A.limit === void 0 && A?.range === void 0) return String((A?.file_path ?? "")).endsWith(".output");',
		signature,
	].join("\n");

	try {
		await fs.writeFile(patchedCliPath, patchedFixture, "utf-8");
		await fs.writeFile(cleanCliPath, "const marker = 2;", "utf-8");

		const result = await verifyCliAnchors({
			patchedCliPath,
			cleanCliPath,
			skipPatchVerifiers: true,
			signatureExpectation: "selected",
		});
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyCliAnchors allow-forced mode still requires signature marker", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "anchor-verify-signature-mode-"),
	);
	const patchedCliPath = path.join(tempDir, "patched-cli.js");
	const cleanCliPath = path.join(tempDir, "clean-cli.js");
	try {
		await fs.writeFile(patchedCliPath, "const marker = 1;", "utf-8");
		await fs.writeFile(cleanCliPath, "const marker = 2;", "utf-8");

		const selectedResult = await verifyCliAnchors({
			patchedCliPath,
			cleanCliPath,
			signatureExpectation: "selected",
		});
		const allowForcedResult = await verifyCliAnchors({
			patchedCliPath,
			cleanCliPath,
			signatureExpectation: "allow-forced",
		});

		const selectedIncludesSignature = allPatches.some(
			(patch) => patch.tag === "signature",
		);
		assert.equal(
			selectedResult.failures.some(
				(failure) => failure.id === "signature-missing",
			),
			selectedIncludesSignature,
		);
		assert.equal(
			allowForcedResult.failures.some(
				(failure) => failure.id === "signature-missing",
			),
			true,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("verifyCliAnchors allow-forced mode allows present signature under tag filters", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "anchor-verify-signature-present-"),
	);
	const patchedCliPath = path.join(tempDir, "patched-cli.js");
	const cleanCliPath = path.join(tempDir, "clean-cli.js");
	try {
		await fs.writeFile(
			patchedCliPath,
			'const marker = "(Claude Code; patched: signature)";',
			"utf-8",
		);
		await fs.writeFile(cleanCliPath, "const marker = 2;", "utf-8");

		const allowForcedResult = await verifyCliAnchors({
			patchedCliPath,
			cleanCliPath,
			signatureExpectation: "allow-forced",
		});

		assert.equal(
			allowForcedResult.failures.some(
				(failure) => failure.id === "signature-unexpected",
			),
			false,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
