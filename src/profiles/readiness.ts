import { getPatchMetadata } from "../patch-metadata.js";
import { profilePatchCatalog, registeredPatches } from "../patches/index.js";
import type { RuntimeSurface } from "../targets/contract.js";
import type { Patch } from "../types.js";
import {
	patchCapabilities,
	patchProbeDefinitions,
	profilePatchCapabilities,
	validatePatchCapabilityCatalog,
} from "./capabilities.js";
import {
	PATCH_EFFECTS,
	PATCH_PROBE_IDS,
	PATCH_SUPPORT_LEVELS,
	type PatchCapability,
	type PatchEffect,
	type PatchExclusionReason,
	type PatchProbeId,
	type PatchProfileName,
	type PatchSupportLevel,
} from "./contract.js";

export const PATCH_SUPPORT_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type PatchAssessment = PatchSupportLevel | "not-assessed";
export type PatchSurfaceReadinessStatus = "ready" | "blocked" | "not-assessed";

export interface PatchSupportRow {
	tag: string;
	label: string;
	group: string;
	effects: PatchEffect[];
	support: PatchAssessment;
	exclusionReason: PatchExclusionReason | null;
	requiredProbes: PatchProbeId[];
	conflictsWith: string[];
}

export interface RequiredPatchProbe {
	id: PatchProbeId;
	label: string;
	evidenceRequired: string;
	status: "not-run";
	tags: string[];
}

export interface PatchSupportSummary {
	total: number;
	supported: number;
	probeRequired: number;
	excluded: number;
	notAssessed: number;
}

export interface PatchSurfaceReadiness {
	schemaVersion: typeof PATCH_SUPPORT_EVIDENCE_SCHEMA_VERSION;
	surface: RuntimeSurface;
	profile: PatchProfileName;
	selectable: boolean;
	readiness: PatchSurfaceReadinessStatus;
	summary: PatchSupportSummary;
	supportedTags: string[];
	candidateTags: string[];
	patches: PatchSupportRow[];
	requiredProbes: RequiredPatchProbe[];
}

const RUNTIME_SURFACES = [
	"cli",
	"desktop-local",
	"desktop-wsl",
	"desktop-ssh",
	"remote-control",
	"self-hosted-runner",
] as const satisfies readonly RuntimeSurface[];

const PROFILE_BY_SURFACE: Record<RuntimeSurface, PatchProfileName> = {
	cli: "cli-full",
	"desktop-local": "desktop-local",
	"desktop-wsl": "desktop-wsl",
	"desktop-ssh": "desktop-ssh",
	"remote-control": "remote-control",
	"self-hosted-runner": "self-hosted-runner",
};

function isCandidate(support: PatchAssessment): boolean {
	return support === "supported" || support === "probe-required";
}

function rowsFor(options: {
	catalog: readonly Patch[];
	capabilities: readonly PatchCapability[];
	surface: RuntimeSurface;
}): PatchSupportRow[] {
	return options.catalog.map((patch, index) => {
		const capability = options.capabilities[index];
		const surfaceSupport = capability.support[options.surface];
		const metadata = getPatchMetadata(patch.tag);
		return {
			tag: patch.tag,
			label: metadata.label,
			group: metadata.group,
			effects: [...capability.effects],
			support: surfaceSupport?.level ?? "not-assessed",
			exclusionReason: surfaceSupport?.exclusionReason ?? null,
			requiredProbes: [...(surfaceSupport?.requiredProbes ?? [])],
			conflictsWith: [...(surfaceSupport?.conflictsWith ?? [])],
		};
	});
}

function validateCandidateComposition(
	catalog: readonly Patch[],
	rows: readonly PatchSupportRow[],
): void {
	const candidateTags = new Set(
		rows.filter((row) => isCandidate(row.support)).map(({ tag }) => tag),
	);
	for (const patch of catalog) {
		if (!candidateTags.has(patch.tag)) continue;
		for (const requiredTag of patch.requires ?? []) {
			if (!candidateTags.has(requiredTag)) {
				throw new Error(
					`Patch ${patch.tag} requires unavailable patch ${requiredTag} on this surface`,
				);
			}
		}
		for (const conflictingTag of patch.conflicts ?? []) {
			if (candidateTags.has(conflictingTag)) {
				throw new Error(
					`Patch ${patch.tag} conflicts with candidate patch ${conflictingTag}`,
				);
			}
		}
	}
	for (const row of rows) {
		if (!candidateTags.has(row.tag)) continue;
		for (const conflictingTag of row.conflictsWith) {
			if (candidateTags.has(conflictingTag)) {
				throw new Error(
					`Patch ${row.tag} conflicts with candidate patch ${conflictingTag}`,
				);
			}
		}
	}
}

function requiredProbesFor(
	rows: readonly PatchSupportRow[],
): RequiredPatchProbe[] {
	const definitionById = new Map(
		patchProbeDefinitions.map((definition) => [definition.id, definition]),
	);
	return PATCH_PROBE_IDS.flatMap((id) => {
		const tags = rows
			.filter((row) => row.requiredProbes.includes(id))
			.map(({ tag }) => tag);
		if (tags.length === 0) return [];
		const definition = definitionById.get(id);
		if (!definition)
			throw new Error(`Missing patch probe definition for ${id}`);
		return [
			{
				id,
				label: definition.label,
				evidenceRequired: definition.evidenceRequired,
				status: "not-run" as const,
				tags,
			},
		];
	});
}

export function buildPatchSurfaceReadiness(options: {
	catalog: readonly Patch[];
	capabilities: readonly PatchCapability[];
	surface: RuntimeSurface;
}): PatchSurfaceReadiness {
	validatePatchCapabilityCatalog(options.catalog, options.capabilities);
	const patches = rowsFor(options);
	validateCandidateComposition(options.catalog, patches);
	const summary: PatchSupportSummary = {
		total: patches.length,
		supported: patches.filter(({ support }) => support === "supported").length,
		probeRequired: patches.filter(({ support }) => support === "probe-required")
			.length,
		excluded: patches.filter(({ support }) => support === "excluded").length,
		notAssessed: patches.filter(({ support }) => support === "not-assessed")
			.length,
	};
	const readiness: PatchSurfaceReadinessStatus =
		summary.notAssessed === summary.total
			? "not-assessed"
			: summary.probeRequired > 0 || summary.notAssessed > 0
				? "blocked"
				: "ready";
	const selectable = options.surface === "cli" && readiness === "ready";

	return {
		schemaVersion: PATCH_SUPPORT_EVIDENCE_SCHEMA_VERSION,
		surface: options.surface,
		profile: PROFILE_BY_SURFACE[options.surface],
		selectable,
		readiness,
		summary,
		supportedTags: patches
			.filter(({ support }) => support === "supported")
			.map(({ tag }) => tag),
		candidateTags: patches
			.filter(({ support }) => isCandidate(support))
			.map(({ tag }) => tag),
		patches,
		requiredProbes: requiredProbesFor(patches),
	};
}

export function createPatchSurfaceReadiness(
	surface: RuntimeSurface,
): PatchSurfaceReadiness {
	const catalog = surface === "cli" ? registeredPatches : profilePatchCatalog;
	const capabilities =
		surface === "cli" ? patchCapabilities : profilePatchCapabilities;
	return buildPatchSurfaceReadiness({
		catalog,
		capabilities,
		surface,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePatchSupportEvidence(
	value: unknown,
): PatchSurfaceReadiness {
	if (!isRecord(value))
		throw new Error("Patch support evidence must be an object");
	if (value.schemaVersion !== PATCH_SUPPORT_EVIDENCE_SCHEMA_VERSION) {
		throw new Error("Unsupported patch support evidence schemaVersion");
	}
	if (
		typeof value.surface !== "string" ||
		!RUNTIME_SURFACES.includes(value.surface as RuntimeSurface)
	) {
		throw new Error("Patch support evidence has an invalid surface");
	}
	if (
		value.readiness !== "ready" &&
		value.readiness !== "blocked" &&
		value.readiness !== "not-assessed"
	) {
		throw new Error("Patch support evidence has an invalid readiness");
	}
	const expected = createPatchSurfaceReadiness(value.surface as RuntimeSurface);
	if (JSON.stringify(value) !== JSON.stringify(expected)) {
		throw new Error(
			"Patch support evidence does not match deterministic surface readiness",
		);
	}
	return value as unknown as PatchSurfaceReadiness;
}

export function createPatchSupportEvidence(
	report: PatchSurfaceReadiness,
): PatchSurfaceReadiness {
	return validatePatchSupportEvidence(JSON.parse(JSON.stringify(report)));
}

export function isPatchEffect(value: string): value is PatchEffect {
	return PATCH_EFFECTS.includes(value as PatchEffect);
}

export function isPatchSupportLevel(value: string): value is PatchSupportLevel {
	return PATCH_SUPPORT_LEVELS.includes(value as PatchSupportLevel);
}
