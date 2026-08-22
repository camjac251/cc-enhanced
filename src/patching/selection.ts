import type {
	PatchProfile,
	PatchProfileReceipt,
} from "../profiles/contract.js";
import type { Patch } from "../types.js";

export interface ResolvedPatchSelection {
	patches: Patch[];
	receipt: PatchProfileReceipt;
}

export interface PatchSelectionOverrides {
	includeTags?: readonly string[];
	excludeTags?: readonly string[];
}

function parsePatchTagList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const tags = [
		...new Set(
			value
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
	return tags.length > 0 ? tags : undefined;
}

export function patchSelectionOverridesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): PatchSelectionOverrides {
	return {
		includeTags: parsePatchTagList(env.CLAUDE_PATCHER_INCLUDE_TAGS),
		excludeTags: parsePatchTagList(env.CLAUDE_PATCHER_EXCLUDE_TAGS),
	};
}

export function resolvePatchSelection(options: {
	catalog: readonly Patch[];
	profile: PatchProfile;
	overrides?: PatchSelectionOverrides;
}): ResolvedPatchSelection {
	const catalogTags = new Set(options.catalog.map((patch) => patch.tag));
	for (const tag of options.profile.includes) {
		if (!catalogTags.has(tag)) {
			throw new Error(
				`Patch profile ${options.profile.name} includes unknown patch tag: ${tag}`,
			);
		}
	}

	const includedTags = new Set(options.profile.includes);
	const excludedTags = new Set(options.profile.excludes.map(({ tag }) => tag));
	for (const [kind, tags] of [
		["include", options.overrides?.includeTags],
		["exclude", options.overrides?.excludeTags],
	] as const) {
		for (const tag of tags ?? []) {
			if (!catalogTags.has(tag)) {
				throw new Error(`Unknown ${kind} override patch tag: ${tag}`);
			}
			if (!includedTags.has(tag) || excludedTags.has(tag)) {
				throw new Error(
					`${kind[0]?.toUpperCase()}${kind.slice(1)} override patch tag is outside profile ${options.profile.name}: ${tag}`,
				);
			}
		}
	}
	const overrideIncludes = options.overrides?.includeTags
		? new Set(options.overrides.includeTags)
		: null;
	const overrideExcludes = new Set(options.overrides?.excludeTags ?? []);
	const patches = options.catalog.filter(
		(patch) =>
			includedTags.has(patch.tag) &&
			!excludedTags.has(patch.tag) &&
			(!overrideIncludes || overrideIncludes.has(patch.tag)) &&
			!overrideExcludes.has(patch.tag),
	);
	if (patches.length === 0) {
		throw new Error("Patch selection resolved to zero patches");
	}
	const selectedTags = new Set(patches.map((patch) => patch.tag));
	for (const patch of patches) {
		for (const requiredTag of patch.requires ?? []) {
			if (!selectedTags.has(requiredTag)) {
				throw new Error(
					`Patch ${patch.tag} requires missing patch ${requiredTag}`,
				);
			}
		}
		for (const conflictingTag of patch.conflicts ?? []) {
			if (selectedTags.has(conflictingTag)) {
				throw new Error(
					`Patch ${patch.tag} conflicts with selected patch ${conflictingTag}`,
				);
			}
		}
	}

	return {
		patches,
		receipt: {
			name: options.profile.name,
			surface: options.profile.surface,
			selectedTags: patches.map((patch) => patch.tag),
			exclusions: options.profile.excludes.map((exclusion) => ({
				...exclusion,
			})),
			requiredProbes: [...options.profile.requiredProbes],
		},
	};
}
