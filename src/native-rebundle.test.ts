import assert from "node:assert/strict";
import { test } from "node:test";
import type { BunEmbeddedModule, BunModule } from "./bun-format.js";
import { parse } from "./loader.js";
import {
	compactRebundledJavaScript,
	rebundleEmbeddedJavaScript,
} from "./native-rebundle.js";

function embeddedJavaScriptModule(
	index: number,
	name: string,
	contents: string,
): BunEmbeddedModule {
	const pointer = { offset: 0, length: 0 };
	const module: BunModule = {
		name: pointer,
		contents: pointer,
		sourcemap: pointer,
		bytecode: pointer,
		moduleInfo: pointer,
		bytecodeOriginPath: pointer,
		encoding: 1,
		loader: 1,
		moduleFormat: 1,
		side: 0,
	};
	return {
		index,
		moduleEntryOffset: 0,
		name,
		contents: Buffer.from(contents, "utf-8"),
		module,
	};
}

test("rebundles static and dynamic imports into one ESM module", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/app/entry.js",
			'import { feature } from "/app/feature.js"; export const result = feature; export async function loadLazy() { return import("/app/lazy.js"); }',
		),
		embeddedJavaScriptModule(
			1,
			"/app/feature.js",
			'export const feature = "feature-loaded";',
		),
		embeddedJavaScriptModule(
			2,
			"/app/lazy.js",
			'export const lazy = "lazy-loaded";',
		),
	];

	const output = await rebundleEmbeddedJavaScript(modules, 0);
	const code = output.toString("utf-8");

	assert.equal(code.startsWith("// @bun\n"), true);
	assert.doesNotMatch(code, /@bun-cjs/);
	assert.match(code, /feature-loaded/);
	assert.match(code, /lazy-loaded/);
	assert.doesNotMatch(code, /\/app\/(?:feature|lazy)\.js/);
	assert.doesNotThrow(() => parse(code));

	const moduleUrl = `data:text/javascript;base64,${output.toString("base64")}`;
	const esmModule = (await import(moduleUrl)) as Record<string, unknown>;
	assert.equal(esmModule.result, "feature-loaded");
	const loadLazy = esmModule.loadLazy;
	assert.equal(typeof loadLazy, "function");
	assert.equal(
		(await (loadLazy as () => Promise<{ lazy: string }>)()).lazy,
		"lazy-loaded",
	);
});

test("rebundles import.meta.require dependencies into the entry module", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/app/entry.js",
			'export function loadLazyValue() { return import.meta.require("/app/lazy.js").lazy; }',
		),
		embeddedJavaScriptModule(
			1,
			"/app/lazy.js",
			'export const lazy = "lazy-required";',
		),
	];

	const output = await rebundleEmbeddedJavaScript(modules, 0);
	const code = output.toString("utf-8");

	assert.match(code, /lazy-required/);
	assert.doesNotMatch(code, /import\.meta\.require/);
	assert.doesNotMatch(code, /\/app\/lazy\.js/);
});

test("compacts a self-contained rebundled patch surface", async () => {
	const source = Buffer.from(`
export function choose(value) {
  if (value === true) {
    return "selected";
  }
  return "fallback";
}
export const plusMinus = "±";
`);

	const output = await compactRebundledJavaScript(source);
	const code = output.toString("utf8");

	assert.ok(output.length < source.length);
	assert.match(code, /selected/);
	assert.match(code, /\\u00b1/);
	assert.doesNotMatch(code, /±/);
	assert.doesNotMatch(code, /import\.meta\.require/);
	assert.doesNotThrow(() => parse(code));
});

test("retains patchable lazy modules without executing them", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/app/entry.js",
			'export const result = "entry";',
		),
		embeddedJavaScriptModule(
			1,
			"/app/lazy.js",
			'globalThis.__lazyPatchSurfaceExecuted = true; export const prompt = "File must be read first";',
		),
		embeddedJavaScriptModule(
			2,
			"/app/unrelated.js",
			'export const unrelated = "not retained";',
		),
	];

	const output = await rebundleEmbeddedJavaScript(modules, 0);
	const code = output.toString("utf-8");

	assert.match(code, /File must be read first/);
	assert.doesNotMatch(code, /not retained/);
	delete (globalThis as Record<string, unknown>).__lazyPatchSurfaceExecuted;
	const moduleUrl = `data:text/javascript;base64,${output.toString("base64")}`;
	await import(moduleUrl);
	assert.equal(
		(globalThis as Record<string, unknown>).__lazyPatchSurfaceExecuted,
		undefined,
	);
});

test("reports build failures without exposing embedded module names", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/private/source/entry.js",
			'import "/private/source/missing.js";',
		),
	];

	await assert.rejects(
		() => rebundleEmbeddedJavaScript(modules, 0),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Embedded JavaScript rebundle failed/);
			assert.doesNotMatch(error.message, /private|missing/);
			return true;
		},
	);
});
