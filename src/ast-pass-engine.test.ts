import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type PatchPassEntry,
	runCombinedAstPasses,
} from "./ast-pass-engine.js";
import { parse } from "./loader.js";

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
