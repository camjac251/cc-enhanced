import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	boundedNodeShape,
	createPatchOutcomeRecorder,
	type PatchPassEntry,
	runCombinedAstPasses,
} from "./ast-pass-engine.js";
import type { Visitor } from "./babel.js";
import { parse } from "./loader.js";

test("patch outcome recorder counts only explicit semantic occurrences", () => {
	const recorder = createPatchOutcomeRecorder();

	recorder.recordMatch("observed");
	recorder.recordMatch("mutated");
	recorder.recordMatch("already-satisfied");
	recorder.recordIssue("match-ambiguous");

	assert.deepEqual(recorder.snapshot(), {
		matched: 3,
		mutated: 1,
		alreadySatisfied: 1,
		verified: 0,
		issues: ["match-ambiguous"],
	});

	recorder.recordVerification(true);
	assert.equal(recorder.snapshot().verified, 1);
});

test("bounded node shapes ignore identifiers and literals but retain structure", () => {
	const first = parse("const short = 1;\n").program.body[0];
	const renamed = parse("const completelyDifferent = 999;\n").program.body[0];
	const changed = parse("const short = call();\n").program.body[0];

	assert.equal(boundedNodeShape(first), boundedNodeShape(renamed));
	assert.notEqual(boundedNodeShape(first), boundedNodeShape(changed));
});

test("combined pass engine treats path.stop as local skip and preserves peer handlers", async () => {
	const ast = parse("const a = 1;\nconst b = 2;\n");
	let stopCalls = 0;
	let peerCalls = 0;
	const errors: string[] = [];
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (msg?: unknown) => {
		warnings.push(String(msg ?? ""));
	};

	const entries: PatchPassEntry[] = [
		{
			tag: "stopper",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration(path: any) {
						stopCalls += 1;
						path.stop();
					},
				},
			},
		},
		{
			tag: "peer",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration() {
						peerCalls += 1;
					},
				},
			},
		},
	];

	try {
		await runCombinedAstPasses(
			ast,
			entries,
			() => {},
			() => {},
			(tag, error) => {
				errors.push(`${tag}: ${error.message}`);
			},
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(errors.length, 0);
	assert.equal(stopCalls, 2);
	assert.equal(peerCalls, 2);
	assert.equal(
		warnings.some((line) => line.includes("stopper called path.stop()")),
		true,
	);
	assert.equal(
		warnings.filter((line) => line.includes("stopper called path.stop()"))
			.length,
		1,
	);
});

test("combined pass engine restores the inherited path.stop method", async () => {
	const ast = parse("const value = 1;\n");
	let visitedPath: any;

	const entries: PatchPassEntry[] = [
		{
			tag: "first",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration(path: any) {
						visitedPath = path;
					},
				},
			},
		},
		{
			tag: "second",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration() {},
				},
			},
		},
	];

	await runCombinedAstPasses(
		ast,
		entries,
		() => {},
		() => {},
		() => {},
	);

	assert.ok(visitedPath);
	assert.equal(Object.hasOwn(visitedPath, "stop"), false);
	assert.equal(visitedPath.stop, Object.getPrototypeOf(visitedPath).stop);
});

test("combined pass engine skips later passes for tags that fail early", async () => {
	const ast = parse('const x = "before";\n');
	const errors: string[] = [];
	let mutateRan = false;
	let healthyMutateRan = false;

	const entries: PatchPassEntry[] = [
		{
			tag: "failing-patch",
			pass: {
				pass: "discover",
				visitor: {
					Program() {
						throw new Error("discover failed");
					},
				},
			},
		},
		{
			tag: "failing-patch",
			pass: {
				pass: "mutate",
				visitor: {
					StringLiteral(path: any) {
						mutateRan = true;
						path.node.value = "after";
					},
				},
			},
		},
		{
			tag: "healthy-patch",
			pass: {
				pass: "mutate",
				visitor: {
					StringLiteral() {
						healthyMutateRan = true;
					},
				},
			},
		},
	];

	await runCombinedAstPasses(
		ast,
		entries,
		() => {},
		() => {},
		(tag, error) => {
			errors.push(`${tag}: ${error.message}`);
		},
	);

	assert.equal(errors.length, 1);
	assert.equal(errors[0].includes("discover failed"), true);
	assert.equal(mutateRan, false);
	assert.equal(healthyMutateRan, true);
});

test("combined pass engine rejects patch-local traversal-global options", async () => {
	const cases: Array<{
		name: "noScope" | "denylist" | "shouldSkip" | "scope" | "blacklist";
		value: unknown;
	}> = [
		{ name: "noScope", value: true },
		{ name: "denylist", value: ["VariableDeclaration"] },
		{ name: "shouldSkip", value: () => true },
		{ name: "scope", value: {} },
		{ name: "blacklist", value: ["VariableDeclaration"] },
	];

	for (const { name, value } of cases) {
		const ast = parse("const value = 1;\n");
		const errors: string[] = [];
		let rejectedCalls = 0;
		let healthyCalls = 0;
		const rejectedVisitor = {
			VariableDeclaration() {
				rejectedCalls += 1;
			},
			[name]: value,
		} as unknown as Visitor;

		await runCombinedAstPasses(
			ast,
			[
				{
					tag: `global-option-${name}`,
					pass: {
						pass: "mutate",
						visitor: rejectedVisitor,
					},
				},
				{
					tag: "healthy-peer",
					pass: {
						pass: "mutate",
						visitor: {
							VariableDeclaration() {
								healthyCalls += 1;
							},
						},
					},
				},
			],
			() => {},
			() => {},
			(tag, error) => {
				errors.push(`${tag}: ${error.message}`);
			},
		);

		assert.deepEqual(errors, [
			`global-option-${name}: Unsupported traversal-global visitor option: ${name}`,
		]);
		assert.equal(rejectedCalls, 0);
		assert.equal(healthyCalls, 1);
	}
});

test("combined pass engine reports handler activity and shared-node overlap", async () => {
	const ast = parse("const first = 1;\nconst second = 2;\n");
	const declarationShapes = ast.program.body
		.filter((node) => node.type === "VariableDeclaration")
		.map((node) => `${boundedNodeShape(node)}\n`)
		.join("");
	const entries: PatchPassEntry[] = [
		{
			tag: "first-patch",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration() {},
				},
			},
		},
		{
			tag: "second-patch",
			pass: {
				pass: "mutate",
				visitor: {
					VariableDeclaration() {},
				},
			},
		},
	];

	const telemetry = await runCombinedAstPasses(
		ast,
		entries,
		() => {},
		() => {},
		() => {},
	);

	assert.deepEqual(telemetry.handlerCalls["first-patch"], {
		discover: 0,
		mutate: 2,
		finalize: 0,
	});
	assert.deepEqual(telemetry.handlerCalls["second-patch"], {
		discover: 0,
		mutate: 2,
		finalize: 0,
	});
	assert.deepEqual(telemetry.overlaps, [
		{
			pass: "mutate",
			nodeType: "VariableDeclaration",
			tags: ["first-patch", "second-patch"],
			count: 2,
		},
	]);
	assert.match(
		telemetry.structuralHashes["first-patch"].mutate.beforeSha256,
		/^[a-f0-9]{64}$/,
	);
	assert.equal(
		telemetry.structuralHashes["first-patch"].mutate.beforeSha256,
		createHash("sha256").update(declarationShapes).digest("hex"),
	);
	assert.equal(
		telemetry.structuralHashes["first-patch"].mutate.beforeSha256,
		telemetry.structuralHashes["second-patch"].mutate.beforeSha256,
	);
	assert.equal(
		telemetry.structuralHashes["first-patch"].mutate.beforeSha256,
		telemetry.structuralHashes["first-patch"].mutate.afterSha256,
	);
});

test("combined pass engine skips original-kind peers after node replacement", async () => {
	const ast = parse("const value = 1;\n");
	let replacementCalls = 0;
	let originalKindPeerCalls = 0;
	const telemetry = await runCombinedAstPasses(
		ast,
		[
			{
				tag: "replacer",
				pass: {
					pass: "mutate",
					visitor: {
						VariableDeclaration(path: any) {
							replacementCalls += 1;
							path.replaceWith({
								type: "ExpressionStatement",
								expression: {
									type: "StringLiteral",
									value: "replacement",
								},
							});
						},
					},
				},
			},
			{
				tag: "original-kind-peer",
				pass: {
					pass: "mutate",
					visitor: {
						VariableDeclaration() {
							originalKindPeerCalls += 1;
						},
					},
				},
			},
		],
		() => {},
		() => {},
		() => {},
	);

	assert.equal(replacementCalls, 1);
	assert.equal(originalKindPeerCalls, 0);
	assert.equal(telemetry.handlerCalls["original-kind-peer"].mutate, 0);
	assert.deepEqual(telemetry.overlaps, []);
});

test("combined pass engine exposes in-place mutations to later peers", async () => {
	const ast = parse('const value = "before";\n');
	let observedValue: string | undefined;
	const telemetry = await runCombinedAstPasses(
		ast,
		[
			{
				tag: "mutator",
				pass: {
					pass: "mutate",
					visitor: {
						StringLiteral(path: any) {
							path.node.value = "after";
						},
					},
				},
			},
			{
				tag: "observer",
				pass: {
					pass: "mutate",
					visitor: {
						StringLiteral(path: any) {
							observedValue = path.node.value;
						},
					},
				},
			},
		],
		() => {},
		() => {},
		() => {},
	);

	assert.equal(observedValue, "after");
	assert.deepEqual(telemetry.overlaps, [
		{
			pass: "mutate",
			nodeType: "StringLiteral",
			tags: ["mutator", "observer"],
			count: 1,
		},
	]);
});

test("overlap telemetry lists only handlers that executed on each node", async () => {
	const ast = parse("const first = 1;\nconst second = 2;\n");
	const telemetry = await runCombinedAstPasses(
		ast,
		[
			{
				tag: "fails-once",
				pass: {
					pass: "mutate",
					visitor: {
						VariableDeclaration() {
							throw new Error("synthetic collision failure");
						},
					},
				},
			},
			{
				tag: "peer-a",
				pass: {
					pass: "mutate",
					visitor: { VariableDeclaration() {} },
				},
			},
			{
				tag: "peer-b",
				pass: {
					pass: "mutate",
					visitor: { VariableDeclaration() {} },
				},
			},
		],
		() => {},
		() => {},
		() => {},
	);

	assert.deepEqual(telemetry.overlaps, [
		{
			pass: "mutate",
			nodeType: "VariableDeclaration",
			tags: ["fails-once", "peer-a", "peer-b"],
			count: 1,
		},
		{
			pass: "mutate",
			nodeType: "VariableDeclaration",
			tags: ["peer-a", "peer-b"],
			count: 1,
		},
	]);
});
