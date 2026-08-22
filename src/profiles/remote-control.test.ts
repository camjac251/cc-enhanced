import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog } from "../patches/index.js";
import { resolvePatchSelection } from "../patching/selection.js";
import { getPatchProfile, patchProfiles } from "./index.js";
import { createPatchSurfaceReadiness } from "./readiness.js";
import {
	REMOTE_CONTROL_CANDIDATE_TAGS,
	REMOTE_CONTROL_EXCLUSIONS,
	REMOTE_CONTROL_REQUIRED_PROBES,
	remoteControlCandidateProfile,
} from "./remote-control.js";
import {
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	STOCK_CLIENT_POLICY_EXCLUSIONS,
} from "./stock-client.js";

test("stock-client policy is an ordered duplicate-free catalog partition", () => {
	const catalogTags = profilePatchCatalog.map(({ tag }) => tag);
	const candidateSet = new Set<string>(STOCK_CLIENT_POLICY_CANDIDATE_TAGS);
	const excludedTags = STOCK_CLIENT_POLICY_EXCLUSIONS.map(({ tag }) => tag);
	const exclusionSet = new Set<string>(excludedTags);

	assert.equal(STOCK_CLIENT_POLICY_CANDIDATE_TAGS.length, 31);
	assert.equal(candidateSet.size, 31);
	assert.equal(excludedTags.length, 15);
	assert.equal(exclusionSet.size, 15);
	assert.ok(
		STOCK_CLIENT_POLICY_CANDIDATE_TAGS.every((tag) => !exclusionSet.has(tag)),
	);
	assert.deepEqual(
		catalogTags.filter((tag) => candidateSet.has(tag)),
		STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	);
	assert.deepEqual(
		catalogTags.filter((tag) => exclusionSet.has(tag)),
		excludedTags,
	);
	assert.deepEqual(
		catalogTags.filter((tag) => candidateSet.has(tag) || exclusionSet.has(tag)),
		catalogTags,
	);
});

test("Remote Control has one conservative reserved candidate profile", () => {
	const readiness = createPatchSurfaceReadiness("remote-control");
	const selection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: remoteControlCandidateProfile,
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
	assert.deepEqual(readiness.candidateTags, REMOTE_CONTROL_CANDIDATE_TAGS);
	assert.deepEqual(
		readiness.patches
			.filter(({ support }) => support === "excluded")
			.map(({ tag, exclusionReason }) => ({
				tag,
				reason: exclusionReason,
			})),
		REMOTE_CONTROL_EXCLUSIONS,
	);
	assert.deepEqual(
		readiness.requiredProbes.map(({ id }) => id),
		REMOTE_CONTROL_REQUIRED_PROBES,
	);
	assert.deepEqual(
		selection.patches.map(({ tag }) => tag),
		REMOTE_CONTROL_CANDIDATE_TAGS,
	);
	assert.equal(selection.patches.at(-1)?.tag, "signature");
	assert.equal(selection.receipt.selectedTags.includes("tools-off"), false);
	assert.equal(
		selection.receipt.selectedTags.includes("tools-off-desktop"),
		true,
	);
});

test("Remote Control remains outside the generic profile registry", () => {
	assert.deepEqual(
		patchProfiles.map(({ name }) => name),
		["cli-full"],
	);
	assert.throws(
		() => getPatchProfile("remote-control"),
		/Unknown patch profile "remote-control"\. Available profiles: cli-full/,
	);
});
