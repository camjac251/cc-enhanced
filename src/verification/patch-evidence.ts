import { createHash } from "node:crypto";
import type {
	AstPassName,
	PatchDriftEvidence,
	PatchEvidenceManifest,
	PatchWitnessValue,
} from "../types.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WITNESS_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const NODE_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PASS_ORDER: AstPassName[] = ["discover", "mutate", "finalize"];
const MAX_PATCH_COUNT = 512;

export interface PatchEvidenceFieldChange {
	field: string;
	previous?: PatchWitnessValue;
	current?: PatchWitnessValue;
}

export interface PatchEvidenceDelta {
	tag: string;
	status: "added" | "removed" | "changed";
	changes: PatchEvidenceFieldChange[];
}

export interface PatchEvidenceComparison {
	schemaVersion: 1;
	sourceChanged: boolean;
	outputChanged: boolean;
	previousSourceSha256: string;
	currentSourceSha256: string;
	previousOutputSha256: string;
	currentOutputSha256: string;
	unchangedPatchCount: number;
	deltas: PatchEvidenceDelta[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requireHash(value: unknown, label: string): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function requireTag(value: unknown, label: string): string {
	if (typeof value !== "string" || !TAG_RE.test(value)) {
		throw new Error(`${label} must be a stable patch tag`);
	}
	return value;
}

function requireCount(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return Number(value);
}

function normalizeWitness(
	value: unknown,
	label: string,
): Record<string, PatchWitnessValue> | undefined {
	if (value === undefined) return undefined;
	const witness = requireRecord(value, label);
	const keys = Object.keys(witness).sort();
	if (keys.length > 64) {
		throw new Error(`${label} contains more than 64 fields`);
	}
	const normalized: Record<string, PatchWitnessValue> = {};
	for (const key of keys) {
		if (!WITNESS_KEY_RE.test(key)) {
			throw new Error(`${label} contains an invalid field name: ${key}`);
		}
		const fieldValue = witness[key];
		if (
			typeof fieldValue !== "string" &&
			typeof fieldValue !== "number" &&
			typeof fieldValue !== "boolean"
		) {
			throw new Error(`${label}.${key} must be a scalar value`);
		}
		if (
			typeof fieldValue === "string" &&
			(fieldValue.length > 128 || /[\r\n]/.test(fieldValue))
		) {
			throw new Error(`${label}.${key} must be a bounded single-line value`);
		}
		if (typeof fieldValue === "number" && !Number.isFinite(fieldValue)) {
			throw new Error(`${label}.${key} must be a finite number`);
		}
		normalized[key] = fieldValue;
	}
	return normalized;
}

function normalizeStructuralHashes(
	value: unknown,
	label: string,
): PatchDriftEvidence["structuralHashes"] {
	if (value === undefined) return undefined;
	const hashes = requireRecord(value, label);
	const unexpectedPasses = Object.keys(hashes).filter(
		(pass) => !PASS_ORDER.includes(pass as AstPassName),
	);
	if (unexpectedPasses.length > 0) {
		throw new Error(`${label} contains unsupported passes`);
	}
	const normalized: NonNullable<PatchDriftEvidence["structuralHashes"]> = {};
	for (const pass of PASS_ORDER) {
		if (hashes[pass] === undefined) continue;
		const passHashes = requireRecord(hashes[pass], `${label}.${pass}`);
		normalized[pass] = {
			beforeSha256: requireHash(
				passHashes.beforeSha256,
				`${label}.${pass}.beforeSha256`,
			),
			afterSha256: requireHash(
				passHashes.afterSha256,
				`${label}.${pass}.afterSha256`,
			),
		};
	}
	return normalized;
}

function normalizePatchEvidence(
	value: unknown,
	index: number,
): PatchDriftEvidence {
	const label = `patches[${index}]`;
	const patch = requireRecord(value, label);
	const tag = requireTag(patch.tag, `${label}.tag`);
	if (typeof patch.passed !== "boolean") {
		throw new Error(`${label}.passed must be a boolean`);
	}
	if (
		patch.coverage !== "verification" &&
		patch.coverage !== "structural" &&
		patch.coverage !== "semantic"
	) {
		throw new Error(`${label}.coverage is unsupported`);
	}

	const rawCalls = requireRecord(patch.handlerCalls, `${label}.handlerCalls`);
	const handlerCalls = {
		discover: requireCount(rawCalls.discover, `${label}.handlerCalls.discover`),
		mutate: requireCount(rawCalls.mutate, `${label}.handlerCalls.mutate`),
		finalize: requireCount(rawCalls.finalize, `${label}.handlerCalls.finalize`),
	};

	if (!Array.isArray(patch.overlaps)) {
		throw new Error(`${label}.overlaps must be an array`);
	}
	if (patch.overlaps.length > 512) {
		throw new Error(`${label}.overlaps contains more than 512 rows`);
	}
	const overlaps = patch.overlaps
		.map((rawOverlap, overlapIndex) => {
			const overlapLabel = `${label}.overlaps[${overlapIndex}]`;
			const overlap = requireRecord(rawOverlap, overlapLabel);
			if (!PASS_ORDER.includes(overlap.pass as AstPassName)) {
				throw new Error(`${overlapLabel}.pass is unsupported`);
			}
			if (
				typeof overlap.nodeType !== "string" ||
				!NODE_TYPE_RE.test(overlap.nodeType)
			) {
				throw new Error(`${overlapLabel}.nodeType is invalid`);
			}
			if (
				!Array.isArray(overlap.tags) ||
				overlap.tags.length > MAX_PATCH_COUNT
			) {
				throw new Error(
					`${overlapLabel}.tags must contain at most ${MAX_PATCH_COUNT} tags`,
				);
			}
			const tags = overlap.tags
				.map((overlapTag, tagIndex) =>
					requireTag(overlapTag, `${overlapLabel}.tags[${tagIndex}]`),
				)
				.sort();
			return {
				pass: overlap.pass as AstPassName,
				nodeType: overlap.nodeType,
				tags,
				count: requireCount(overlap.count, `${overlapLabel}.count`),
			};
		})
		.sort(
			(left, right) =>
				PASS_ORDER.indexOf(left.pass) - PASS_ORDER.indexOf(right.pass) ||
				left.nodeType.localeCompare(right.nodeType) ||
				left.tags.join("\0").localeCompare(right.tags.join("\0")),
		);
	const witness = normalizeWitness(patch.witness, `${label}.witness`);
	const structuralHashes = normalizeStructuralHashes(
		patch.structuralHashes,
		`${label}.structuralHashes`,
	);

	return {
		tag,
		passed: patch.passed,
		coverage: patch.coverage,
		handlerCalls,
		...(structuralHashes && Object.keys(structuralHashes).length > 0
			? { structuralHashes }
			: {}),
		...(witness ? { witness } : {}),
		overlaps,
	};
}

export function extractPatchEvidence(value: unknown): PatchEvidenceManifest {
	const root = requireRecord(value, "patch evidence input");
	const direct =
		root.schemaVersion === 1 && Array.isArray(root.patches)
			? root
			: isRecord(root.result) && isRecord(root.result.evidence)
				? root.result.evidence
				: undefined;
	if (!direct) {
		throw new Error("Input does not contain patch evidence");
	}
	if (direct.schemaVersion !== 1) {
		throw new Error(
			`Unsupported patch evidence schema: ${direct.schemaVersion}`,
		);
	}
	if (!Array.isArray(direct.patches)) {
		throw new Error("Patch evidence patches must be an array");
	}
	if (direct.patches.length > MAX_PATCH_COUNT) {
		throw new Error(
			`Patch evidence contains more than ${MAX_PATCH_COUNT} patches`,
		);
	}
	const patches = direct.patches
		.map(normalizePatchEvidence)
		.sort((left, right) => left.tag.localeCompare(right.tag));
	const seenTags = new Set<string>();
	for (const patch of patches) {
		if (seenTags.has(patch.tag)) {
			throw new Error(`Duplicate patch evidence tag: ${patch.tag}`);
		}
		seenTags.add(patch.tag);
	}
	return {
		schemaVersion: 1,
		sourceSha256: requireHash(
			direct.sourceSha256,
			"patch evidence sourceSha256",
		),
		outputSha256: requireHash(
			direct.outputSha256,
			"patch evidence outputSha256",
		),
		patches,
	};
}

function overlapFingerprint(overlaps: PatchDriftEvidence["overlaps"]): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(overlaps))
		.digest("hex");
	return `sha256:${digest};count=${overlaps.length}`;
}

function pushScalarChange(
	changes: PatchEvidenceFieldChange[],
	field: string,
	previous: PatchWitnessValue | undefined,
	current: PatchWitnessValue | undefined,
): void {
	if (Object.is(previous, current)) return;
	changes.push({ field, previous, current });
}

function comparePatch(
	previous: PatchDriftEvidence,
	current: PatchDriftEvidence,
): PatchEvidenceFieldChange[] {
	const changes: PatchEvidenceFieldChange[] = [];
	pushScalarChange(changes, "passed", previous.passed, current.passed);
	pushScalarChange(changes, "coverage", previous.coverage, current.coverage);
	for (const pass of PASS_ORDER) {
		pushScalarChange(
			changes,
			`handlerCalls.${pass}`,
			previous.handlerCalls[pass],
			current.handlerCalls[pass],
		);
	}
	for (const pass of PASS_ORDER) {
		pushScalarChange(
			changes,
			`structuralHashes.${pass}.beforeSha256`,
			previous.structuralHashes?.[pass]?.beforeSha256,
			current.structuralHashes?.[pass]?.beforeSha256,
		);
		pushScalarChange(
			changes,
			`structuralHashes.${pass}.afterSha256`,
			previous.structuralHashes?.[pass]?.afterSha256,
			current.structuralHashes?.[pass]?.afterSha256,
		);
	}
	const witnessKeys = [
		...new Set([
			...Object.keys(previous.witness ?? {}),
			...Object.keys(current.witness ?? {}),
		]),
	].sort();
	for (const key of witnessKeys) {
		pushScalarChange(
			changes,
			`witness.${key}`,
			previous.witness?.[key],
			current.witness?.[key],
		);
	}
	const previousOverlaps = overlapFingerprint(previous.overlaps);
	const currentOverlaps = overlapFingerprint(current.overlaps);
	pushScalarChange(changes, "overlaps", previousOverlaps, currentOverlaps);
	return changes;
}

export function comparePatchEvidence(
	previousInput: PatchEvidenceManifest,
	currentInput: PatchEvidenceManifest,
): PatchEvidenceComparison {
	const previous = extractPatchEvidence(previousInput);
	const current = extractPatchEvidence(currentInput);
	const previousByTag = new Map(
		previous.patches.map((patch) => [patch.tag, patch]),
	);
	const currentByTag = new Map(
		current.patches.map((patch) => [patch.tag, patch]),
	);
	const tags = [
		...new Set([...previousByTag.keys(), ...currentByTag.keys()]),
	].sort();
	const deltas: PatchEvidenceDelta[] = [];
	let unchangedPatchCount = 0;
	for (const tag of tags) {
		const before = previousByTag.get(tag);
		const after = currentByTag.get(tag);
		if (!before) {
			deltas.push({
				tag,
				status: "added",
				changes: [{ field: "present", previous: false, current: true }],
			});
			continue;
		}
		if (!after) {
			deltas.push({
				tag,
				status: "removed",
				changes: [{ field: "present", previous: true, current: false }],
			});
			continue;
		}
		const changes = comparePatch(before, after);
		if (changes.length === 0) {
			unchangedPatchCount += 1;
			continue;
		}
		deltas.push({ tag, status: "changed", changes });
	}

	return {
		schemaVersion: 1,
		sourceChanged: previous.sourceSha256 !== current.sourceSha256,
		outputChanged: previous.outputSha256 !== current.outputSha256,
		previousSourceSha256: previous.sourceSha256,
		currentSourceSha256: current.sourceSha256,
		previousOutputSha256: previous.outputSha256,
		currentOutputSha256: current.outputSha256,
		unchangedPatchCount,
		deltas,
	};
}

function formatValue(value: PatchWitnessValue | undefined): string {
	if (value === undefined) return "missing";
	return `\`${String(value).replaceAll("|", "\\|").replaceAll("`", "\\`")}\``;
}

export function formatPatchEvidenceComparisonMarkdown(
	comparison: PatchEvidenceComparison,
): string {
	const lines = [
		"# Patch Evidence Comparison",
		"",
		`- Source hash changed: ${comparison.sourceChanged ? "yes" : "no"}`,
		`- Output hash changed: ${comparison.outputChanged ? "yes" : "no"}`,
		`- Unchanged patches: ${comparison.unchangedPatchCount}`,
		`- Changed patch rows: ${comparison.deltas.length}`,
		"",
	];
	if (comparison.deltas.length === 0) {
		lines.push("No per-patch evidence changed.", "");
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		"| Patch | Status | Evidence field | Previous | Current |",
		"| --- | --- | --- | --- | --- |",
	);
	for (const delta of comparison.deltas) {
		for (const change of delta.changes) {
			lines.push(
				`| \`${delta.tag}\` | ${delta.status} | \`${change.field}\` | ${formatValue(change.previous)} | ${formatValue(change.current)} |`,
			);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
