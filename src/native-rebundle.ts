import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearTraverseCache, generator } from "./babel.js";
import { BUN_MODULE_FORMAT_ESM, type BunEmbeddedModule } from "./bun-format.js";
import { escapeNonAsciiForBundle, parse } from "./loader.js";
import { extractEmbeddedModulesFromNativeBinary } from "./native.js";

const LATIN1_ENCODING = 1;
const JAVASCRIPT_LOADER = 1;
const VIRTUAL_ENTRY_SPECIFIER = "cc-enhanced-embedded-entry";
const VIRTUAL_NAMESPACE = "cc-enhanced-embedded";
const LAZY_PATCH_SURFACE_ANCHORS = [
	"the prompt names Claude/Anthropic in any form",
	"File must be read first",
	"Error editing file",
	"Message queued for delivery to",
] as const;

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
		format: "esm";
		splitting: false;
		treeShaking: false;
		minify: {
			whitespace: true;
			syntax: boolean;
			identifiers: boolean;
		};
		sourcemap: "none";
		write: false;
		logLevel: "silent";
		throw: false;
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

export interface PatchableNativeJavaScript {
	code: Buffer;
	sourceMode: "entry" | "rebundled";
	sourceModuleCount: number;
}

function isRebundleJavaScriptModule(module: BunEmbeddedModule): boolean {
	return (
		module.module.encoding === LATIN1_ENCODING &&
		module.module.loader === JAVASCRIPT_LOADER &&
		module.module.moduleFormat === BUN_MODULE_FORMAT_ESM
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
		const syntheticName = `module-${module.index}.js`;
		syntheticByIndex.set(module.index, syntheticName);
		moduleBySyntheticName.set(syntheticName, module);
	}
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
	const lazyModuleSpecifiers = modules
		.filter(
			(module) =>
				module.index !== entry.index &&
				isRebundleJavaScriptModule(module) &&
				LAZY_PATCH_SURFACE_ANCHORS.some((anchor) =>
					module.contents.includes(anchor),
				),
		)
		.map((module) => JSON.stringify(module.name));
	await fs.writeFile(
		virtualEntryPath,
		`import ${JSON.stringify(VIRTUAL_ENTRY_SPECIFIER)};\nexport * from ${JSON.stringify(VIRTUAL_ENTRY_SPECIFIER)};\nasync function _ccEnhancedRetainLazyModules() {\n  if (globalThis.__ccEnhancedRetainLazyModules === true) {\n    await Promise.all([${lazyModuleSpecifiers.map((specifier) => `import(${specifier})`).join(",")}]);\n  }\n}\nvoid _ccEnhancedRetainLazyModules;\n`,
		"utf-8",
	);

	try {
		const buildResult = await runtime.build({
			entrypoints: [virtualEntryPath],
			target: "bun",
			format: "esm",
			splitting: false,
			treeShaking: false,
			minify: {
				whitespace: true,
				syntax: false,
				identifiers: false,
			},
			sourcemap: "none",
			write: false,
			logLevel: "silent",
			throw: false,
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
									contents: rewriteEmbeddedRequireCalls(module.contents),
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
		return Buffer.from(await buildResult.outputs[0].arrayBuffer());
	} finally {
		modulesByName.clear();
		syntheticByIndex.clear();
		moduleBySyntheticName.clear();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export function compactRebundledJavaScript(source: Buffer): Buffer {
	if (source.includes("/$bunfs/root/chunk-")) {
		throw new Error(
			"Rebundled JavaScript compaction left embedded module dependencies",
		);
	}
	const ast = parse(source.toString("utf8"));
	try {
		const compacted = generator(ast, {
			compact: true,
			comments: false,
			minified: false,
		}).code;
		return Buffer.from(
			escapeNonAsciiForBundle(`// @bun\n${compacted}`),
			"utf8",
		);
	} finally {
		clearTraverseCache();
	}
}

export async function extractPatchableJavaScriptFromNativeBinary(
	filePath: string,
): Promise<PatchableNativeJavaScript> {
	const embedded = extractEmbeddedModulesFromNativeBinary(filePath);
	try {
		const entry = embedded.modules.find(
			(module) => module.index === embedded.entryPointId,
		);
		if (!entry) {
			throw new Error("Could not locate embedded entry-point module");
		}
		const rebundleModules = embedded.modules.filter(isRebundleJavaScriptModule);
		if (!isRebundleJavaScriptModule(entry) || rebundleModules.length <= 1) {
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
