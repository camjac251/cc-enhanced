import assert from "node:assert/strict";
import { test } from "node:test";
import { emitMemoryCheckpoint, forceGarbageCollection } from "./profiling.js";

test("emitMemoryCheckpoint stays passive when profiling is disabled", () => {
	let memorySamples = 0;
	let emittedLines = 0;

	emitMemoryCheckpoint(
		"disabled-probe",
		false,
		() => {
			memorySamples += 1;
			return process.memoryUsage();
		},
		() => {
			emittedLines += 1;
		},
	);

	assert.equal(memorySamples, 0);
	assert.equal(emittedLines, 0);
});

test("forceGarbageCollection requests a synchronous Bun collection", () => {
	const calls: Array<boolean | undefined> = [];

	forceGarbageCollection({
		Bun: {
			gc(force) {
				calls.push(force);
			},
		},
	});

	assert.deepEqual(calls, [true]);
});

test("forceGarbageCollection is a no-op without Bun.gc", () => {
	assert.doesNotThrow(() => forceGarbageCollection({}));
});
