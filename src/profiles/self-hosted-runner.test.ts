import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog } from "../patches/index.js";
import { resolvePatchSelection } from "../patching/selection.js";
import { getPatchProfile, patchProfiles } from "./index.js";
import { createPatchSurfaceReadiness } from "./readiness.js";
import {
	SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	SELF_HOSTED_RUNNER_EXCLUSIONS,
	SELF_HOSTED_RUNNER_REQUIRED_PROBES,
	selfHostedRunnerCandidateProfile,
} from "./self-hosted-runner.js";
import {
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	STOCK_CLIENT_POLICY_EXCLUSIONS,
} from "./stock-client.js";

test("self-hosted runner uses the exact ordered stock-client partition", () => {
	const catalogTags = profilePatchCatalog.map(({ tag }) => tag);
	const candidateSet = new Set<string>(SELF_HOSTED_RUNNER_CANDIDATE_TAGS);
	const excludedTags = SELF_HOSTED_RUNNER_EXCLUSIONS.map(({ tag }) => tag);
	const exclusionSet = new Set<string>(excludedTags);

	assert.deepEqual(
		SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
		STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	);
	assert.deepEqual(
		SELF_HOSTED_RUNNER_EXCLUSIONS,
		STOCK_CLIENT_POLICY_EXCLUSIONS,
	);
	assert.equal(candidateSet.size, 30);
	assert.equal(exclusionSet.size, 15);
	assert.ok(
		SELF_HOSTED_RUNNER_CANDIDATE_TAGS.every((tag) => !exclusionSet.has(tag)),
	);
	assert.deepEqual(
		catalogTags.filter((tag) => candidateSet.has(tag) || exclusionSet.has(tag)),
		catalogTags,
	);
});

test("self-hosted runner has one conservative reserved candidate profile", () => {
	const readiness = createPatchSurfaceReadiness("self-hosted-runner");
	const selection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: selfHostedRunnerCandidateProfile,
	});

	assert.equal(readiness.selectable, false);
	assert.equal(readiness.readiness, "blocked");
	assert.deepEqual(readiness.summary, {
		total: 45,
		supported: 0,
		probeRequired: 30,
		excluded: 15,
		notAssessed: 0,
	});
	assert.deepEqual(readiness.candidateTags, SELF_HOSTED_RUNNER_CANDIDATE_TAGS);
	assert.deepEqual(
		readiness.patches
			.filter(({ support }) => support === "excluded")
			.map(({ tag, exclusionReason }) => ({
				tag,
				reason: exclusionReason,
			})),
		SELF_HOSTED_RUNNER_EXCLUSIONS,
	);
	assert.deepEqual(
		readiness.requiredProbes.map(({ id }) => id),
		SELF_HOSTED_RUNNER_REQUIRED_PROBES,
	);
	assert.deepEqual(
		selection.receipt.selectedTags,
		SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	);
	assert.equal(selection.patches.length, 30);
	assert.equal(selection.patches.at(-1)?.tag, "signature");
	assert.equal(selection.receipt.selectedTags.includes("tools-off"), false);
	assert.equal(
		selection.receipt.selectedTags.includes("tools-off-desktop"),
		true,
	);
});

test("self-hosted runner remains outside the generic profile registry", () => {
	assert.deepEqual(
		patchProfiles.map(({ name }) => name),
		["cli-full"],
	);
	assert.throws(
		() => getPatchProfile("self-hosted-runner"),
		/Unknown patch profile "self-hosted-runner"\. Available profiles: cli-full/,
	);
});
