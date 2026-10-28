import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { BunEmbeddedModule, BunModule } from "./bun-format.js";
import { unwrapBunCjsModule } from "./native-linux.js";
import { rebundleEmbeddedJavaScript } from "./native-rebundle.js";

function embeddedJavaScriptModule(
	index: number,
	name: string,
	contents: string,
	flags: Partial<Pick<BunModule, "encoding" | "loader" | "moduleFormat">> = {},
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
		...flags,
	};
	return {
		index,
		moduleEntryOffset: 0,
		name,
		contents: Buffer.from(contents, "utf-8"),
		module,
	};
}

function executeRebundledModule(output: Buffer): Record<string, unknown> {
	const wrapper = unwrapBunCjsModule(output.toString("utf8"));
	assert(
		wrapper,
		"Rebundled native entry must have an executable CommonJS wrapper",
	);
	const module = { exports: {} as Record<string, unknown> };
	new Function(
		"exports",
		"require",
		"module",
		"__filename",
		"__dirname",
		wrapper.body,
	)(
		module.exports,
		createRequire(import.meta.url),
		module,
		"/app/entry.js",
		"/app",
	);
	return module.exports;
}

test("rebundles static and dynamic imports into an executable native entry", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/app/entry.js",
			'import { feature } from "./feature.js"; export const result = feature; export function requireFeature() { return require("./feature.js").feature; } export async function loadLazy() { return import("/app/lazy.js"); }',
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
	const esmModule = executeRebundledModule(output);
	assert.equal(esmModule.result, "feature-loaded");
	assert.equal((esmModule.requireFeature as () => string)(), "feature-loaded");
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
	const loaded = executeRebundledModule(output);
	assert.equal((loaded.loadLazyValue as () => string)(), "lazy-required");
});

test("CommonJS entry envelopes retain their exports and embedded dependencies", async () => {
	const output = await rebundleEmbeddedJavaScript(
		[
			embeddedJavaScriptModule(
				0,
				"/app/entry.js",
				'// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname){ module.exports = { result: require("./dependency.js").value }; });',
				{ moduleFormat: 2 },
			),
			embeddedJavaScriptModule(
				1,
				"/app/dependency.js",
				'export const value = "CommonJS dependency loaded";',
			),
		],
		0,
	);
	assert.equal(
		executeRebundledModule(output).result,
		"CommonJS dependency loaded",
	);
});

test("retains every JavaScript module without initializing unreachable entries", async () => {
	const modules = [
		embeddedJavaScriptModule(
			0,
			"/app/entry.js",
			'export const result = "entry";',
		),
		embeddedJavaScriptModule(
			1,
			"/app/lazy.js",
			'globalThis.__lazyAuditModuleExecuted = true; export const prompt = "unreachable lazy prompt";',
		),
		embeddedJavaScriptModule(
			2,
			"/app/unrelated.bin",
			'export const unrelated = "independent audit source";',
			{ encoding: 0 },
		),
		embeddedJavaScriptModule(
			3,
			"/app/commonjs.js",
			'// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname){ globalThis.__lazyAuditModuleExecuted = true; module.exports = { prompt: "unreachable CommonJS prompt" }; });',
			{ moduleFormat: 2 },
		),
		embeddedJavaScriptModule(4, "/app/asset.dat", "non-JavaScript asset data", {
			loader: 0,
			moduleFormat: 0,
		}),
	];

	const output = await rebundleEmbeddedJavaScript(modules, 0);
	const code = output.toString("utf-8");

	assert.match(code, /unreachable lazy prompt/);
	assert.match(code, /independent audit source/);
	assert.match(code, /unreachable CommonJS prompt/);
	assert.doesNotMatch(code, /non-JavaScript asset data/);
	delete (globalThis as Record<string, unknown>).__lazyAuditModuleExecuted;
	assert.equal(executeRebundledModule(output).result, "entry");
	assert.equal(
		(globalThis as Record<string, unknown>).__lazyAuditModuleExecuted,
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

test("native entry initializes external named imports before dependent code", async () => {
	const output = await rebundleEmbeddedJavaScript(
		[
			embeddedJavaScriptModule(
				0,
				"/app/entry.js",
				`import { first } from "/app/first.js"; import { second } from "/app/second.js"; export const result = [first(), second()];`,
			),
			embeddedJavaScriptModule(
				1,
				"/app/first.js",
				`import { basename as pick } from "node:path"; export const first = () => pick("/one/first.txt");`,
			),
			embeddedJavaScriptModule(
				2,
				"/app/second.js",
				`import { basename as pick } from "node:path"; export const second = () => pick("/two/second.txt");`,
			),
		],
		0,
	);
	assert.deepEqual(executeRebundledModule(output).result, [
		"first.txt",
		"second.txt",
	]);
});

test("native require metadata keeps the entry resolver despite a nested shadow", async () => {
	const output = await rebundleEmbeddedJavaScript(
		[
			embeddedJavaScriptModule(
				0,
				"/app/entry.js",
				`function nested(require) { const load = import.meta.require; return load("node:path").basename("/safe/file.txt"); }
				export const result = nested(() => ({ basename: () => "wrong" }));
				export const text = "import.meta.require";`,
			),
		],
		0,
	);
	const loaded = executeRebundledModule(output);
	assert.equal(loaded.result, "file.txt");
	assert.equal(loaded.text, "import.meta.require");
});

test("rebundled import metadata resolves against the executing entry instead of virtual build paths", async () => {
	const output = await rebundleEmbeddedJavaScript(
		[
			embeddedJavaScriptModule(
				0,
				"/virtual/build/entry.js",
				`import { info } from "/virtual/build/dependency.js"; export const result = info;`,
			),
			embeddedJavaScriptModule(
				1,
				"/virtual/build/dependency.js",
				`export const info = { dir: import.meta.dir, dirname: import.meta.dirname, path: import.meta.path, filename: import.meta.filename, file: import.meta.file, url: import.meta.url };`,
			),
		],
		0,
	);
	assert.deepEqual(executeRebundledModule(output).result, {
		dir: "/app",
		dirname: "/app",
		path: "/app/entry.js",
		filename: "/app/entry.js",
		file: "entry.js",
		url: pathToFileURL("/app/entry.js").href,
	});
});

test("rebundled worker reentry preserves its own initialization and shared data", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-worker-entry-"));
	try {
		const output = await rebundleEmbeddedJavaScript(
			[
				embeddedJavaScriptModule(
					0,
					"/virtual/main.js",
					`
import { isMainThread } from "node:worker_threads";
import { pathToFileURL } from "node:url";
if (!isMainThread) throw new Error("Main initialization ran in the worker");
const metadata = { HOOKS_WORKER_URL: "/virtual/worker.js" };
const stamp = new SharedArrayBuffer(4);
const worker = new Worker(pathToFileURL(metadata.HOOKS_WORKER_URL), {name:"entry-probe",workerData:{stamp}});
worker.onmessage = ({data}) => { console.log(JSON.stringify({data,shared:new Int32Array(stamp)[0]})); worker.terminate(); };
worker.onerror = (error) => { console.error(error.message); process.exit(1); };
`,
				),
				embeddedJavaScriptModule(
					1,
					"/virtual/worker.js",
					`
import { isMainThread, workerData } from "node:worker_threads";
import { value } from "./shared.js";
if (isMainThread) throw new Error("Worker initialization ran in main");
new Int32Array(workerData.stamp)[0] = value;
self.postMessage({role:"worker", value});
`,
				),
				embeddedJavaScriptModule(
					2,
					"/virtual/shared.js",
					"export const value = 37;",
				),
			],
			0,
		);
		const wrapper = unwrapBunCjsModule(output.toString("utf8"));
		assert(wrapper);
		const entry = path.join(root, "entry.cjs");
		await fs.writeFile(entry, wrapper.body);
		const result = spawnSync(process.execPath, [entry], {
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			data: { role: "worker", value: 37 },
			shared: 37,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
