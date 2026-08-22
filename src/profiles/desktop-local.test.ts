import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog } from "../patches/index.js";
import { resolvePatchSelection } from "../patching/selection.js";
import {
	DESKTOP_LOCAL_CANDIDATE_TAGS,
	DESKTOP_LOCAL_EXCLUSIONS,
	DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS,
	DESKTOP_LOCAL_POLICY_EXCLUSIONS,
	DESKTOP_LOCAL_REQUIRED_PROBES,
	DESKTOP_LOCAL_TARGET_EXCLUSIONS,
	desktopLocalCandidateProfile,
} from "./desktop-local.js";
import { getPatchProfile, patchProfiles } from "./index.js";
import { createPatchSurfaceReadiness } from "./readiness.js";

test("Desktop-local candidate profile preserves policy and records exact-target exclusions", () => {
	const readiness = createPatchSurfaceReadiness("desktop-local");
	const selection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: desktopLocalCandidateProfile,
	});

	assert.equal(readiness.selectable, false);
	assert.equal(readiness.readiness, "blocked");
	assert.deepEqual(readiness.summary, {
		total: 46,
		supported: 0,
		probeRequired: 31,
		excluded: 15,
		notAssessed: 0,
	});
	assert.deepEqual(
		readiness.candidateTags,
		DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS,
	);
	assert.deepEqual(
		readiness.patches
			.filter(({ support }) => support === "excluded")
			.map(({ tag, exclusionReason }) => ({
				tag,
				reason: exclusionReason,
			})),
		DESKTOP_LOCAL_POLICY_EXCLUSIONS,
	);
	assert.deepEqual(
		readiness.requiredProbes.map(({ id }) => id),
		DESKTOP_LOCAL_REQUIRED_PROBES,
	);
	assert.deepEqual(
		selection.patches.map(({ tag }) => tag),
		DESKTOP_LOCAL_CANDIDATE_TAGS,
	);
	assert.equal(selection.receipt.selectedTags.length, 30);
	assert.equal(selection.receipt.exclusions.length, 16);
	assert.deepEqual(selection.receipt.exclusions, DESKTOP_LOCAL_EXCLUSIONS);
	assert.deepEqual(DESKTOP_LOCAL_TARGET_EXCLUSIONS, [
		{ tag: "effort-stack", reason: "unsupported-runtime" },
	]);
	assert.equal(
		selection.patches.some(({ tag }) => tag === "effort-stack"),
		false,
	);
	assert.equal(selection.patches.at(-1)?.tag, "signature");
	assert.equal(
		selection.patches.some(({ tag }) => tag === "tools-off"),
		false,
	);
	assert.equal(
		selection.patches.some(({ tag }) => tag === "tools-off-desktop"),
		true,
	);
});

test("Desktop-local remains reserved outside the generic profile registry", () => {
	assert.deepEqual(
		patchProfiles.map(({ name }) => name),
		["cli-full"],
	);
	assert.throws(
		() => getPatchProfile("desktop-local"),
		/Unknown patch profile "desktop-local"\. Available profiles: cli-full/,
	);
});
