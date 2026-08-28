import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as t from "@babel/types";
import { print } from "./loader.js";
import { PatchRunner } from "./patch-runner.js";
import { signature } from "./patches/signature.js";
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

test("PatchRunner reuses the verification output when signature injection is off", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-output-reuse-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	let printCalls = 0;

	const patch: Patch = {
		tag: "output-reuse-probe",
		verify: () => true,
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "off",
			runtime: {
				print(ast) {
					printCalls += 1;
					return print(ast);
				},
			},
		});

		const result = await runner.run(targetPath, { dryRun: true });

		assert.equal(printCalls, 1);
		assert.deepEqual(result.appliedTags, ["output-reuse-probe"]);
		assert.deepEqual(result.failedTags, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner reuses the verification output when failures skip signature injection", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-failed-output-reuse-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	let printCalls = 0;

	const patch: Patch = {
		tag: "failed-output-reuse-probe",
		verify: () => "synthetic verification failure",
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "force",
			runtime: {
				print(ast) {
					printCalls += 1;
					return print(ast);
				},
			},
		});

		const result = await runner.run(targetPath, { dryRun: true });

		assert.equal(printCalls, 1);
		assert.deepEqual(result.appliedTags, []);
		assert.deepEqual(result.failedTags, ["failed-output-reuse-probe"]);
		assert.equal(
			result.verifications.some(
				(verification) => verification.tag === signature.tag,
			),
			false,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner prints again after successful signature injection", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-signed-output-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(
		targetPath,
		`
function makeTitle(theme, version) {
  return jsxs(theme, { children: [jsx(theme, { bold: true, children: "Claude Code" }), " ", jsxs(theme, { dimColor: true, children: ["v", version] })] });
}
function versionText(version) {
  return \`\${version} (Claude Code)\${suffix()}\`;
}
`,
		"utf-8",
	);
	let printCalls = 0;

	const patch: Patch = {
		tag: "signed-output-probe",
		verify: () => true,
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "force",
			runtime: {
				print(ast) {
					printCalls += 1;
					return print(ast);
				},
			},
		});

		const result = await runner.run(targetPath, { dryRun: true });

		assert.equal(printCalls, 2);
		assert.deepEqual(result.appliedTags, ["signed-output-probe", "signature"]);
		assert.deepEqual(result.failedTags, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner prints a partially mutated AST after signature injection throws", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-signature-failure-output-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	const originalPostApply = signature.postApply;
	const printedOutputs: string[] = [];

	const patch: Patch = {
		tag: "signature-failure-output-probe",
		verify: () => true,
	};

	try {
		signature.postApply = (ast) => {
			ast.program.body.push(
				t.expressionStatement(t.stringLiteral("signature attempted")),
			);
			throw new Error("synthetic signature failure");
		};
		const runner = new PatchRunner([patch], {
			signaturePolicy: "force",
			runtime: {
				print(ast) {
					const output = print(ast);
					printedOutputs.push(output);
					return output;
				},
			},
		});

		const result = await runner.run(targetPath, { dryRun: true });

		assert.equal(printedOutputs.length, 2);
		assert.equal(printedOutputs[0].includes("signature attempted"), false);
		assert.equal(printedOutputs[1].includes("signature attempted"), true);
		assert.deepEqual(result.failedTags, ["signature"]);
		assert.equal(
			result.verifications.find(
				(verification) => verification.tag === signature.tag,
			)?.reason,
			"Signature injection failed: synthetic signature failure",
		);
	} finally {
		signature.postApply = originalPostApply;
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
		assert.equal(clearCalls, 2);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner releases traversal state at verification boundaries", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-pass-release-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	let clearCalls = 0;
	let garbageCollectionCalls = 0;

	const patch: Patch = {
		tag: "pass-release-probe",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					Program() {},
				},
			},
		],
		verify: () => {
			assert.equal(clearCalls, 1);
			assert.equal(garbageCollectionCalls, 1);
			return true;
		},
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "off",
			runtime: {
				clearTraverseCache() {
					clearCalls += 1;
				},
				forceGarbageCollection() {
					garbageCollectionCalls += 1;
				},
			},
		});

		const result = await runner.run(targetPath);
		assert.deepEqual(result.failedTags, []);
		assert.equal(clearCalls, 3);
		assert.equal(garbageCollectionCalls, 2);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner releases traversal state midway through large verifier sets", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-mid-verifier-release-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");
	let clearCalls = 0;
	let garbageCollectionCalls = 0;

	const patches: Patch[] = Array.from({ length: 32 }, (_value, index) => ({
		tag: `mid-verifier-release-probe-${index}`,
		verify: () => {
			if (index < 16) {
				assert.equal(clearCalls, 1);
				assert.equal(garbageCollectionCalls, 1);
			} else {
				assert.equal(clearCalls, 2);
				assert.equal(garbageCollectionCalls, 2);
			}
			return true;
		},
	}));

	try {
		const runner = new PatchRunner(patches, {
			signaturePolicy: "off",
			runtime: {
				clearTraverseCache() {
					clearCalls += 1;
				},
				forceGarbageCollection() {
					garbageCollectionCalls += 1;
				},
			},
		});

		const result = await runner.run(targetPath);
		assert.deepEqual(result.failedTags, []);
		assert.equal(clearCalls, 4);
		assert.equal(garbageCollectionCalls, 3);
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
		const runner = new PatchRunner(
			[
				{
					tag: "profile-probe",
					verify: () => true,
				},
			],
			{
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
			},
		);

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
		assert.ok(
			profileLines.some((line) =>
				line.includes("checkpoint=patch.pass-state-released"),
			),
		);
		assert.ok(
			profileLines.some((line) =>
				line.includes("checkpoint=patch.verifier-state-released"),
			),
		);
		assert.ok(
			profileLines.some((line) =>
				line.includes("checkpoint=patch.verify.profile-probe"),
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

test("PatchRunner skips structural telemetry when evidence is not requested", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-no-structural-evidence-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");

	const patch: Patch = {
		tag: "no-evidence-probe",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					StringLiteral(path: any) {
						if (path.node.value === "before") {
							path.node.value = "after";
						}
					},
				},
			},
		],
		verify: () => true,
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "off",
			telemetryLevel: "none",
		});
		const result = await runner.run(targetPath);
		const patchEvidence = result.evidence?.patches[0];

		assert.equal(result.failedTags.length, 0);
		assert.equal(patchEvidence?.coverage, "verification");
		assert.deepEqual(patchEvidence?.handlerCalls, {
			discover: 0,
			mutate: 0,
			finalize: 0,
		});
		assert.equal(patchEvidence?.structuralHashes, undefined);
		assert.deepEqual(patchEvidence?.overlaps, []);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner emits per-patch drift evidence without another parse", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-evidence-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");

	const patch: Patch = {
		tag: "evidence-probe",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					StringLiteral(path: any) {
						if (path.node.value === "before") {
							path.node.value = "after";
						}
					},
				},
			},
		],
		verify: () => true,
		verifyWithWitness: () => ({
			result: true,
			witness: {
				targetCount: 1,
				patchedCount: 1,
			},
		}),
	};

	try {
		const runner = new PatchRunner([patch], {
			signaturePolicy: "off",
			telemetryLevel: "deep",
		});
		const result = await runner.run(targetPath);

		assert.equal(result.failedTags.length, 0);
		assert.equal(result.evidence?.schemaVersion, 1);
		assert.match(result.evidence?.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
		assert.match(result.evidence?.outputSha256 ?? "", /^[a-f0-9]{64}$/);
		assert.notEqual(
			result.evidence?.sourceSha256,
			result.evidence?.outputSha256,
		);
		const patchEvidence = result.evidence?.patches[0];
		assert.deepEqual(
			{
				tag: patchEvidence?.tag,
				passed: patchEvidence?.passed,
				coverage: patchEvidence?.coverage,
				handlerCalls: patchEvidence?.handlerCalls,
				witness: patchEvidence?.witness,
				overlaps: patchEvidence?.overlaps,
			},
			{
				tag: "evidence-probe",
				passed: true,
				coverage: "semantic",
				handlerCalls: {
					discover: 0,
					mutate: 1,
					finalize: 0,
				},
				witness: {
					targetCount: 1,
					patchedCount: 1,
				},
				overlaps: [],
			},
		);
		assert.deepEqual(Object.keys(patchEvidence?.structuralHashes ?? {}), [
			"mutate",
		]);
		assert.match(
			patchEvidence?.structuralHashes?.mutate?.beforeSha256 ?? "",
			/^[a-f0-9]{64}$/,
		);
		assert.match(
			patchEvidence?.structuralHashes?.mutate?.afterSha256 ?? "",
			/^[a-f0-9]{64}$/,
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner preserves semantic evidence when verification fails", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "runner-failed-evidence-"),
	);
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, "const marker = true;\n", "utf-8");

	const patch: Patch = {
		tag: "failed-evidence-probe",
		verify: () => "missing target",
		verifyWithWitness: () => ({
			result: "missing target",
			witness: {
				targetCount: 0,
				requiredCount: 1,
			},
		}),
	};

	try {
		const runner = new PatchRunner([patch], { signaturePolicy: "off" });
		const result = await runner.run(targetPath);
		const patchEvidence = result.evidence?.patches[0];

		assert.deepEqual(result.failedTags, ["failed-evidence-probe"]);
		assert.equal(patchEvidence?.passed, false);
		assert.equal(patchEvidence?.coverage, "semantic");
		assert.deepEqual(patchEvidence?.witness, {
			targetCount: 0,
			requiredCount: 1,
		});
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("PatchRunner normalizes plain and structured verification at one seam", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-outcomes-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");

	const patches: Patch[] = [
		{ tag: "plain-true", verify: () => true },
		{ tag: "plain-string", verify: () => "plain failure" },
		{
			tag: "plain-witness",
			verify: () => true,
			verifyWithWitness: () => ({
				result: true,
				witness: { targetCount: 1 },
			}),
		},
		{
			tag: "structured-result",
			astPasses: (_ast, recorder) => [
				{
					pass: "mutate",
					visitor: {
						StringLiteral(path: any) {
							if (path.node.value !== "before") return;
							recorder?.recordMatch("mutated");
							path.node.value = "after";
						},
					},
				},
			],
			verify: () => true,
			verifyWithWitness: () => ({
				passed: true,
				issues: [],
				witness: { targetCount: 1, patchedCount: 1 },
			}),
		},
	];

	try {
		const result = await new PatchRunner(patches, {
			signaturePolicy: "off",
		}).run(targetPath, { dryRun: true });

		assert.deepEqual(result.appliedTags, [
			"plain-true",
			"plain-witness",
			"structured-result",
		]);
		assert.deepEqual(result.failedTags, ["plain-string"]);
		assert.deepEqual(
			result.evidence?.patches.find(
				(patch) => patch.tag === "structured-result",
			)?.outcomes,
			{
				matched: 1,
				mutated: 1,
				alreadySatisfied: 0,
				verified: 1,
				issues: [],
			},
		);
		assert.deepEqual(
			result.evidence?.patches.find((patch) => patch.tag === "plain-string")
				?.outcomes?.issues,
			["verification-failed"],
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
