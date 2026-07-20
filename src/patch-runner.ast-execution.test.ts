import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PatchRunner } from "./patch-runner.js";
import type { Patch } from "./types.js";

test("PatchRunner executes astPasses", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-ast-pass-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");

	let passMutations = 0;
	const patch: Patch = {
		tag: "combined-pass-only",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					StringLiteral(path: any) {
						if (path.node.value !== "before") return;
						path.node.value = "after";
						passMutations += 1;
					},
				},
			},
		],
		verify: (code) => {
			if (!code.includes('"after"')) {
				return "combined pass did not mutate output";
			}
			return true;
		},
	};

	try {
		const runner = new PatchRunner([patch], { signaturePolicy: "off" });
		const result = await runner.run(targetPath);

		assert.equal(passMutations > 0, true);
		assert.equal(result.failedTags.length, 0);
		assert.equal(result.appliedTags.includes("combined-pass-only"), true);

		const written = await fs.readFile(targetPath, "utf-8");
		assert.equal(written.includes('"after"'), true);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner clears the traversal cache when generation throws", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-cleanup-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");
	const generationError = new Error("synthetic generation failure");
	let clearCalls = 0;

	const patch: Patch = {
		tag: "cleanup-probe",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					Program() {},
				},
			},
		],
		verify: () => true,
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "off",
			runtime: {
				print() {
					throw generationError;
				},
				clearTraverseCache() {
					clearCalls += 1;
				},
			},
		});

		await assert.rejects(() => runner.run(targetPath), generationError);
		assert.equal(clearCalls, 1);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner profiling emits memory checkpoints", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-profile-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	const previousProfile = process.env.CLAUDE_PATCHER_PROFILE;
	const profileLines: string[] = [];
	const mebibyte = 1024 * 1024;

	try {
		process.env.CLAUDE_PATCHER_PROFILE = "1";
		const runner = new PatchRunner([], {
			signaturePolicy: "off",
			runtime: {
				memoryUsage() {
					return {
						rss: 128 * mebibyte,
						heapTotal: 64 * mebibyte,
						heapUsed: 32 * mebibyte,
						external: 8 * mebibyte,
						arrayBuffers: 4 * mebibyte,
					};
				},
				profileSink(line) {
					profileLines.push(line);
				},
			},
		});

		await runner.run(targetPath, { dryRun: true });

		assert.ok(
			profileLines.includes(
				"[profile:memory] checkpoint=patch.ast-parsed rss=128.0MiB heapUsed=32.0MiB heapTotal=64.0MiB external=8.0MiB arrayBuffers=4.0MiB",
			),
		);
		assert.ok(
			profileLines.some((line) =>
				line.includes("checkpoint=patch.cache-cleared"),
			),
		);
	} finally {
		if (previousProfile === undefined) {
			delete process.env.CLAUDE_PATCHER_PROFILE;
		} else {
			process.env.CLAUDE_PATCHER_PROFILE = previousProfile;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
