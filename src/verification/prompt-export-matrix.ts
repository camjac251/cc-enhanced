import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	comparePromptExports,
	type PromptExportCompareResult,
} from "./prompt-export-compare.js";

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface PromptExportMatrixInput {
	previousCleanExportDir: string;
	previousPatchedExportDir: string;
	currentCleanExportDir: string;
	currentPatchedExportDir: string;
	etcClaudeDir: string;
	watchPaths?: readonly string[];
	minOverlapLineLength?: number;
}

export interface PromptDependencyStats {
	corpusPath: string;
	present: boolean;
	promptCount: number;
	templatedPromptCount: number;
	slotCount: number;
	uniqueSignatureCount: number;
	invalidReferenceCount: number;
	unusedMappingCount: number;
	hashCoverageComplete: boolean;
	signatureCounts: Record<string, number>;
}

export interface PromptDependencyComparison {
	exactMultisetParity: boolean;
	coverageComplete: boolean;
	promptDelta: number;
	templatedPromptDelta: number;
	slotDelta: number;
	addedSignatureCount: number;
	removedSignatureCount: number;
}

export interface PromptExportMatrixResult {
	paths: {
		previousCleanExportDir: string;
		previousPatchedExportDir: string;
		currentCleanExportDir: string;
		currentPatchedExportDir: string;
		etcClaudeDir: string;
	};
	comparisons: {
		cleanRelease: PromptExportCompareResult;
		patchedRelease: PromptExportCompareResult;
		previousPatchImpact: PromptExportCompareResult;
		currentPatchImpact: PromptExportCompareResult;
	};
	dependencies: {
		previousClean: PromptDependencyStats;
		previousPatched: PromptDependencyStats;
		currentClean: PromptDependencyStats;
		currentPatched: PromptDependencyStats;
	};
	dependencyParity: {
		cleanRelease: PromptDependencyComparison;
		patchedRelease: PromptDependencyComparison;
		previousPatchImpact: PromptDependencyComparison;
		currentPatchImpact: PromptDependencyComparison;
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function zeroDependencyStats(corpusPath: string): PromptDependencyStats {
	return {
		corpusPath,
		present: false,
		promptCount: 0,
		templatedPromptCount: 0,
		slotCount: 0,
		uniqueSignatureCount: 0,
		invalidReferenceCount: 0,
		unusedMappingCount: 0,
		hashCoverageComplete: false,
		signatureCounts: {},
	};
}

async function collectPromptDependencies(
	exportDir: string,
): Promise<PromptDependencyStats> {
	const corpusPath = path.join(exportDir, "prompt-corpus.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(corpusPath, "utf8")) as unknown;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return zeroDependencyStats(corpusPath);
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read prompt corpus at ${corpusPath}: ${reason}`);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.prompts)) {
		throw new Error(`Invalid prompt corpus schema at ${corpusPath}`);
	}
	if (parsed.prompts.length > 200_000) {
		throw new Error(`Prompt corpus exceeds the 200000-entry safety limit`);
	}

	let templatedPromptCount = 0;
	let slotCount = 0;
	let invalidReferenceCount = 0;
	let unusedMappingCount = 0;
	let hashCoverageComplete = true;
	const signatureCounts = new Map<string, number>();
	for (const [index, rawPrompt] of parsed.prompts.entries()) {
		if (!isRecord(rawPrompt)) {
			throw new Error(`Invalid prompt corpus entry ${index} at ${corpusPath}`);
		}
		if (!Array.isArray(rawPrompt.identifiers)) {
			throw new Error(
				`Prompt corpus entry ${index} is missing identifiers at ${corpusPath}`,
			);
		}
		const identifierMap = rawPrompt.identifierMap;
		if (!isRecord(identifierMap)) {
			throw new Error(
				`Prompt corpus entry ${index} is missing identifierMap at ${corpusPath}`,
			);
		}
		const rawExpressionHashMap = rawPrompt.expressionHashMap;
		if (rawExpressionHashMap !== undefined && !isRecord(rawExpressionHashMap)) {
			throw new Error(
				`Prompt corpus entry ${index} has an invalid expressionHashMap at ${corpusPath}`,
			);
		}
		const expressionHashMap = isRecord(rawExpressionHashMap)
			? rawExpressionHashMap
			: undefined;
		const identifiers = rawPrompt.identifiers.map((identifier) => {
			if (!Number.isSafeInteger(identifier) || Number(identifier) < 0) {
				throw new Error(
					`Prompt corpus entry ${index} has an invalid identifier at ${corpusPath}`,
				);
			}
			return Number(identifier);
		});
		const mappingKeys = Object.keys(identifierMap).sort(
			(left, right) =>
				Number(left) - Number(right) || left.localeCompare(right),
		);
		const expressionHashes: Record<string, string> = {};
		for (const key of mappingKeys) {
			const displayToken = identifierMap[key];
			if (
				typeof displayToken !== "string" ||
				displayToken.length > 512 ||
				/[\r\n]/.test(displayToken)
			) {
				throw new Error(
					`Prompt corpus entry ${index} has an invalid identifier mapping at ${corpusPath}`,
				);
			}
		}
		if (expressionHashMap) {
			const hashKeys = Object.keys(expressionHashMap).sort(
				(left, right) =>
					Number(left) - Number(right) || left.localeCompare(right),
			);
			if (
				mappingKeys.length !== hashKeys.length ||
				mappingKeys.some((key, keyIndex) => key !== hashKeys[keyIndex])
			) {
				throw new Error(
					`Prompt corpus entry ${index} identifier and expression hash mappings differ at ${corpusPath}`,
				);
			}
			for (const key of mappingKeys) {
				const expressionHash = expressionHashMap[key];
				if (
					typeof expressionHash !== "string" ||
					!SHA256_RE.test(expressionHash)
				) {
					throw new Error(
						`Prompt corpus entry ${index} has an invalid expression hash at ${corpusPath}`,
					);
				}
				expressionHashes[key] = expressionHash;
			}
		}
		const referencedKeys = new Set(identifiers.map(String));
		invalidReferenceCount += [...referencedKeys].filter(
			(key) => !(key in identifierMap),
		).length;
		unusedMappingCount += mappingKeys.filter(
			(key) => !referencedKeys.has(key),
		).length;
		slotCount += identifiers.length;
		if (identifiers.length === 0 && mappingKeys.length === 0) continue;
		templatedPromptCount += 1;
		if (!expressionHashMap) {
			hashCoverageComplete = false;
			continue;
		}
		const signature = sha256(
			JSON.stringify({
				identifiers,
				expressionHashes,
			}),
		);
		signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
	}
	const sortedSignatureCounts = Object.fromEntries(
		[...signatureCounts.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		),
	);
	return {
		corpusPath,
		present: true,
		promptCount: parsed.prompts.length,
		templatedPromptCount,
		slotCount,
		uniqueSignatureCount: signatureCounts.size,
		invalidReferenceCount,
		unusedMappingCount,
		hashCoverageComplete,
		signatureCounts: sortedSignatureCounts,
	};
}

function compareDependencyStats(
	previous: PromptDependencyStats,
	current: PromptDependencyStats,
): PromptDependencyComparison {
	const signatures = new Set([
		...Object.keys(previous.signatureCounts),
		...Object.keys(current.signatureCounts),
	]);
	let addedSignatureCount = 0;
	let removedSignatureCount = 0;
	for (const signature of signatures) {
		const before = previous.signatureCounts[signature] ?? 0;
		const after = current.signatureCounts[signature] ?? 0;
		addedSignatureCount += Math.max(after - before, 0);
		removedSignatureCount += Math.max(before - after, 0);
	}
	const coverageComplete =
		previous.present &&
		current.present &&
		previous.hashCoverageComplete &&
		current.hashCoverageComplete;
	return {
		exactMultisetParity:
			coverageComplete &&
			addedSignatureCount === 0 &&
			removedSignatureCount === 0,
		coverageComplete,
		promptDelta: current.promptCount - previous.promptCount,
		templatedPromptDelta:
			current.templatedPromptCount - previous.templatedPromptCount,
		slotDelta: current.slotCount - previous.slotCount,
		addedSignatureCount,
		removedSignatureCount,
	};
}

export async function comparePromptExportMatrix(
	input: PromptExportMatrixInput,
): Promise<PromptExportMatrixResult> {
	const compare = (baseExportDir: string, patchedExportDir: string) =>
		comparePromptExports({
			baseExportDir,
			patchedExportDir,
			etcClaudeDir: input.etcClaudeDir,
			watchPaths: input.watchPaths,
			minOverlapLineLength: input.minOverlapLineLength,
		});

	const cleanRelease = await compare(
		input.previousCleanExportDir,
		input.currentCleanExportDir,
	);
	const patchedRelease = await compare(
		input.previousPatchedExportDir,
		input.currentPatchedExportDir,
	);
	const previousPatchImpact = await compare(
		input.previousCleanExportDir,
		input.previousPatchedExportDir,
	);
	const currentPatchImpact = await compare(
		input.currentCleanExportDir,
		input.currentPatchedExportDir,
	);

	const previousClean = await collectPromptDependencies(
		input.previousCleanExportDir,
	);
	const previousPatched = await collectPromptDependencies(
		input.previousPatchedExportDir,
	);
	const currentClean = await collectPromptDependencies(
		input.currentCleanExportDir,
	);
	const currentPatched = await collectPromptDependencies(
		input.currentPatchedExportDir,
	);

	return {
		paths: {
			previousCleanExportDir: input.previousCleanExportDir,
			previousPatchedExportDir: input.previousPatchedExportDir,
			currentCleanExportDir: input.currentCleanExportDir,
			currentPatchedExportDir: input.currentPatchedExportDir,
			etcClaudeDir: input.etcClaudeDir,
		},
		comparisons: {
			cleanRelease,
			patchedRelease,
			previousPatchImpact,
			currentPatchImpact,
		},
		dependencies: {
			previousClean,
			previousPatched,
			currentClean,
			currentPatched,
		},
		dependencyParity: {
			cleanRelease: compareDependencyStats(previousClean, currentClean),
			patchedRelease: compareDependencyStats(previousPatched, currentPatched),
			previousPatchImpact: compareDependencyStats(
				previousClean,
				previousPatched,
			),
			currentPatchImpact: compareDependencyStats(currentClean, currentPatched),
		},
	};
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

export function formatPromptExportMatrixMarkdown(
	result: PromptExportMatrixResult,
): string {
	const comparisonRows = [
		["Clean release drift", "cleanRelease"],
		["Patched release drift", "patchedRelease"],
		["Previous patch impact", "previousPatchImpact"],
		["Current patch impact", "currentPatchImpact"],
	] as const;
	const lines = [
		"# Four-Way Prompt Export Comparison",
		"",
		`Previous clean: \`${result.paths.previousCleanExportDir}\``,
		`Previous patched: \`${result.paths.previousPatchedExportDir}\``,
		`Current clean: \`${result.paths.currentCleanExportDir}\``,
		`Current patched: \`${result.paths.currentPatchedExportDir}\``,
		`Runtime policy dir: \`${result.paths.etcClaudeDir}\``,
		"",
		"## Comparison Matrix",
		"",
		"| Comparison | Changed files | Added | Removed | Watched changes | Dependency parity | Slot delta | Added signatures | Removed signatures |",
		"| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
	];
	for (const [label, key] of comparisonRows) {
		const comparison = result.comparisons[key];
		const parity = result.dependencyParity[key];
		const watchedChanges =
			comparison.watchedSurfaces.changed +
			comparison.watchedSurfaces.added +
			comparison.watchedSurfaces.removed +
			comparison.watchedSurfaces.missing;
		const parityStatus = parity.coverageComplete
			? parity.exactMultisetParity
				? "exact"
				: "changed"
			: "unknown";
		lines.push(
			`| ${label} | ${comparison.files.changed} | ${comparison.files.added} | ${comparison.files.removed} | ${watchedChanges} | ${parityStatus} | ${signed(parity.slotDelta)} | ${parity.addedSignatureCount} | ${parity.removedSignatureCount} |`,
		);
	}
	lines.push(
		"",
		"## Interpolation Dependency Health",
		"",
		"| Export | Corpus | Hash coverage | Prompts | Templated | Slots | Unique signatures | Invalid references | Unused mappings |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const [label, stats] of [
		["Previous clean", result.dependencies.previousClean],
		["Previous patched", result.dependencies.previousPatched],
		["Current clean", result.dependencies.currentClean],
		["Current patched", result.dependencies.currentPatched],
	] as const) {
		lines.push(
			`| ${label} | ${stats.present ? "present" : "missing"} | ${stats.hashCoverageComplete ? "complete" : "incomplete"} | ${stats.promptCount} | ${stats.templatedPromptCount} | ${stats.slotCount} | ${stats.uniqueSignatureCount} | ${stats.invalidReferenceCount} | ${stats.unusedMappingCount} |`,
		);
	}
	lines.push(
		"",
		"Dependency signatures use raw-expression hashes persisted by the exporter; the report does not include expression text.",
		"",
	);
	return `${lines.join("\n")}\n`;
}
