import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as t from "@babel/types";
import { generator } from "./babel.js";
import {
	BUN_MODULE_FORMAT_CJS,
	BUN_MODULE_FORMAT_ESM,
	type BunEmbeddedModule,
	hasBunCjsHeader,
} from "./bun-format.js";
import { parse } from "./loader.js";
import { extractEmbeddedModulesFromNativeBinary } from "./native.js";
import { unwrapBunCjsModule } from "./native-linux.js";

const JAVASCRIPT_LOADER = 1;
const VIRTUAL_ENTRY_SPECIFIER = "cc-enhanced-embedded-entry";
const VIRTUAL_NAMESPACE = "cc-enhanced-embedded";
export const NATIVE_METADATA_BINDING = "_ccEnhancedNativeMeta";

interface EmbeddedBuildResolveArgs {
	path: string;
	importer: string;
}

interface EmbeddedBuildLoadArgs {
	path: string;
}

interface EmbeddedBuildPluginBuilder {
	onResolve(
		options: { filter: RegExp },
		callback: (
			args: EmbeddedBuildResolveArgs,
		) => { path: string; namespace?: string; external?: boolean } | undefined,
	): void;
	onLoad(
		options: { filter: RegExp; namespace: string },
		callback: (
			args: EmbeddedBuildLoadArgs,
		) => { contents: Buffer; loader: "js" } | undefined,
	): void;
}

interface EmbeddedBuildRuntime {
	build(options: {
		entrypoints: string[];
		target: "bun";
		format: "cjs";
		splitting: false;
		treeShaking: false;
		minify: {
			whitespace: false;
			syntax: boolean;
			identifiers: boolean;
		};
		sourcemap: "none";
		write: false;
		logLevel: "silent";
		throw: false;
		define: Record<string, string>;
		plugins: Array<{
			name: string;
			setup(build: EmbeddedBuildPluginBuilder): void;
		}>;
	}): Promise<{
		success: boolean;
		outputs: Array<{ arrayBuffer(): Promise<ArrayBuffer> }>;
		logs: unknown[];
	}>;
}

export interface ExtractedNativeJavaScript {
	code: Buffer;
	sourceMode: "entry" | "rebundled";
	sourceModuleCount: number;
}

function isRebundleJavaScriptModule(module: BunEmbeddedModule): boolean {
	// Use serialized source metadata, not filenames, text anchors, encoding,
	// or reachability. JavaScript-like loaders also serialize an ESM/CJS format.
	return (
		module.module.loader === JAVASCRIPT_LOADER ||
		module.module.moduleFormat === BUN_MODULE_FORMAT_ESM ||
		module.module.moduleFormat === BUN_MODULE_FORMAT_CJS
	);
}

function resolveEmbeddedImport(
	specifier: string,
	importerName: string | undefined,
	modulesByName: Map<string, BunEmbeddedModule>,
): BunEmbeddedModule | undefined {
	const exact = modulesByName.get(specifier);
	if (exact) return exact;
	if (!importerName || !specifier.startsWith(".")) return undefined;
	return modulesByName.get(
		path.posix.resolve(path.posix.dirname(importerName), specifier),
	);
}

function rewriteEmbeddedRequireCalls(contents: Buffer): Buffer {
	const source = contents.toString("utf8");
	if (!source.includes("import.meta.require")) return contents;
	return Buffer.from(
		source.replace(/import\.meta\.require(?=\(\s*["'])/g, "require"),
		"utf8",
	);
}

function embeddedModuleSource(contents: Buffer): Buffer {
	if (!hasBunCjsHeader(contents)) return contents;
	const wrapper = unwrapBunCjsModule(contents.toString("utf8"));
	if (!wrapper) {
		throw new Error("Embedded CommonJS module has an unsupported envelope");
	}
	return Buffer.from(wrapper.body, "utf8");
}

function prepareEmbeddedWorkerEntries(
	modules: readonly BunEmbeddedModule[],
	modulesByName: ReadonlyMap<string, BunEmbeddedModule>,
): {
	worker: BunEmbeddedModule | undefined;
	contentsByIndex: Map<number, Buffer>;
} {
	let worker: BunEmbeddedModule | undefined;
	const contentsByIndex = new Map<number, Buffer>();
	for (const module of modules) {
		if (
			!isRebundleJavaScriptModule(module) ||
			!module.contents.includes("HOOKS_WORKER_URL")
		)
			continue;
		const ast = parse(embeddedModuleSource(module.contents).toString("utf8"));
		let changed = false;
		t.traverseFast(ast, (node) => {
			if (
				!t.isObjectProperty(node) ||
				!(
					(!node.computed &&
						t.isIdentifier(node.key, { name: "HOOKS_WORKER_URL" })) ||
					t.isStringLiteral(node.key, { value: "HOOKS_WORKER_URL" })
				)
			)
				return;
			if (!t.isStringLiteral(node.value))
				throw new Error(
					"Embedded worker metadata is not a static module reference",
				);
			const target = modulesByName.get(node.value.value);
			if (
				!target ||
				!isRebundleJavaScriptModule(target) ||
				target.contents.length === 0
			) {
				throw new Error(
					"Embedded worker metadata does not resolve to executable JavaScript",
				);
			}
			if (worker && worker.index !== target.index)
				throw new Error(
					"Multiple embedded worker entries require distinct dispatch roles",
				);
			worker = target;
			node.value = t.memberExpression(
				t.identifier(NATIVE_METADATA_BINDING),
				t.identifier("path"),
			);
			changed = true;
		});
		if (changed)
			contentsByIndex.set(
				module.index,
				Buffer.from(generator(ast, { compact: true, comments: false }).code),
			);
	}
	return { worker, contentsByIndex };
}

export async function rebundleEmbeddedJavaScript(
	modules: BunEmbeddedModule[],
	entryPointId: number,
): Promise<Buffer> {
	const entry = modules.find((module) => module.index === entryPointId);
	if (!entry || !isRebundleJavaScriptModule(entry)) {
		throw new Error(
			"Embedded entry point is not a supported JavaScript module",
		);
	}

	const modulesByName = new Map(
		modules.map((module) => [module.name, module] as const),
	);
	const syntheticByIndex = new Map<number, string>();
	const moduleBySyntheticName = new Map<string, BunEmbeddedModule>();
	for (const module of modules) {
		if (!isRebundleJavaScriptModule(module)) continue;
		if (module.contents.includes(NATIVE_METADATA_BINDING))
			throw new Error(
				"Embedded source collides with the native metadata binding",
			);
		const syntheticName = `module-${module.index}.js`;
		syntheticByIndex.set(module.index, syntheticName);
		moduleBySyntheticName.set(syntheticName, module);
	}
	const { worker, contentsByIndex } = prepareEmbeddedWorkerEntries(
		modules,
		modulesByName,
	);
	const entrySyntheticName = syntheticByIndex.get(entry.index);
	if (!entrySyntheticName) {
		throw new Error("Embedded entry point has no JavaScript build identity");
	}
	const runtime = (
		globalThis as typeof globalThis & {
			Bun?: EmbeddedBuildRuntime;
		}
	).Bun;
	if (!runtime) {
		throw new Error("Embedded JavaScript rebundling requires the Bun runtime");
	}

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-native-rebundle-"),
	);
	const virtualEntryPath = path.join(tempDir, "cc-native-entry.js");
	// Retain every JavaScript module, including out-of-band lazy entries.
	// Imports in an uncalled function preserve source without initializing it.
	const lazyModuleSpecifiers = modules
		.filter(
			(module) =>
				module.index !== entry.index && isRebundleJavaScriptModule(module),
		)
		.map((module) => JSON.stringify(module.name));
	// Both roles share one module graph, but only their own entry is initialized.
	const startup = worker
		? `if (require("node:worker_threads").isMainThread) { module.exports = require(${JSON.stringify(VIRTUAL_ENTRY_SPECIFIER)}); } else { module.exports = require(${JSON.stringify(worker.name)}); }\n`
		: `module.exports = require(${JSON.stringify(VIRTUAL_ENTRY_SPECIFIER)});\n`;
	await fs.writeFile(
		virtualEntryPath,
		`${startup}async function _ccEnhancedRetainLazyModules() {\n  await Promise.all([${lazyModuleSpecifiers.map((specifier) => `import(${specifier})`).join(",")}]);\n}\nvoid _ccEnhancedRetainLazyModules;\n`,
		"utf-8",
	);

	try {
		const buildResult = await runtime.build({
			entrypoints: [virtualEntryPath],
			target: "bun",
			format: "cjs",
			splitting: false,
			treeShaking: false,
			minify: {
				whitespace: false,
				syntax: false,
				identifiers: false,
			},
			sourcemap: "none",
			write: false,
			logLevel: "silent",
			throw: false,
			define: {
				"import.meta.dir": `${NATIVE_METADATA_BINDING}.dir`,
				"import.meta.dirname": `${NATIVE_METADATA_BINDING}.dir`,
				"import.meta.path": `${NATIVE_METADATA_BINDING}.path`,
				"import.meta.filename": `${NATIVE_METADATA_BINDING}.path`,
				"import.meta.file": `${NATIVE_METADATA_BINDING}.file`,
				"import.meta.url": `${NATIVE_METADATA_BINDING}.url`,
				"import.meta.require": `${NATIVE_METADATA_BINDING}.require`,
			},
			plugins: [
				{
					name: "embedded-module-reader",
					setup(build) {
						build.onResolve({ filter: /^cc-enhanced-embedded-entry$/ }, () => ({
							path: entrySyntheticName,
							namespace: VIRTUAL_NAMESPACE,
						}));
						build.onResolve({ filter: /.*/ }, (args) => {
							const importer = moduleBySyntheticName.get(args.importer);
							const resolved = resolveEmbeddedImport(
								args.path,
								importer?.name,
								modulesByName,
							);
							if (!resolved) return undefined;
							if (!isRebundleJavaScriptModule(resolved)) {
								return { path: args.path, external: true };
							}
							const syntheticName = syntheticByIndex.get(resolved.index);
							if (!syntheticName) {
								throw new Error(
									"Resolved JavaScript module has no build identity",
								);
							}
							return {
								path: syntheticName,
								namespace: VIRTUAL_NAMESPACE,
							};
						});
						build.onLoad(
							{ filter: /.*/, namespace: VIRTUAL_NAMESPACE },
							(args) => {
								const module = moduleBySyntheticName.get(args.path);
								if (!module) return undefined;
								return {
									contents: rewriteEmbeddedRequireCalls(
										embeddedModuleSource(
											contentsByIndex.get(module.index) ?? module.contents,
										),
									),
									loader: "js",
								};
							},
						);
					},
				},
			],
		});

		if (!buildResult.success || buildResult.outputs.length !== 1) {
			throw new Error(
				`Embedded JavaScript rebundle failed (${buildResult.logs.length} diagnostics)`,
			);
		}
		const output = Buffer.from(await buildResult.outputs[0].arrayBuffer());
		if (!output.includes(NATIVE_METADATA_BINDING)) return output;
		const prefix = output.subarray(0, 256).toString("utf8");
		const wrapper =
			/^\/\/ @bun @bun-cjs\r?\n\(function\(exports,\s*require,\s*module,\s*__filename,\s*__dirname\)\s*\{/.exec(
				prefix,
			);
		if (!wrapper)
			throw new Error(
				"Rebundled native entry has an unsupported CommonJS envelope",
			);
		const prelude = Buffer.from(
			`\nconst ${NATIVE_METADATA_BINDING} = { dir: __dirname, path: __filename, file: require("node:path").basename(__filename), url: require("node:url").pathToFileURL(__filename).href, require };\n`,
		);
		return Buffer.concat([
			output.subarray(0, wrapper[0].length),
			prelude,
			output.subarray(wrapper[0].length),
		]);
	} finally {
		modulesByName.clear();
		syntheticByIndex.clear();
		moduleBySyntheticName.clear();
		contentsByIndex.clear();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export async function extractJavaScriptFromNativeBinary(
	filePath: string,
): Promise<ExtractedNativeJavaScript> {
	const embedded = extractEmbeddedModulesFromNativeBinary(filePath);
	try {
		const entry = embedded.modules.find(
			(module) => module.index === embedded.entryPointId,
		);
		if (!entry) {
			throw new Error("Could not locate embedded entry-point module");
		}
		if (!isRebundleJavaScriptModule(entry)) {
			throw new Error("Embedded entry point is not a JavaScript module");
		}
		const rebundleModules = embedded.modules.filter(isRebundleJavaScriptModule);
		if (rebundleModules.length <= 1) {
			return {
				code: Buffer.from(entry.contents),
				sourceMode: "entry",
				sourceModuleCount: 1,
			};
		}

		return {
			code: await rebundleEmbeddedJavaScript(
				embedded.modules,
				embedded.entryPointId,
			),
			sourceMode: "rebundled",
			sourceModuleCount: rebundleModules.length,
		};
	} finally {
		embedded.modules.length = 0;
	}
}
