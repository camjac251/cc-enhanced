import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog, registeredPatches } from "../patches/index.js";
import { patchProfiles } from "../profiles/index.js";
import {
	REMOTE_CONTROL_CANDIDATE_TAGS,
	remoteControlCandidateProfile,
} from "../profiles/remote-control.js";
import {
	SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	selfHostedRunnerCandidateProfile,
} from "../profiles/self-hosted-runner.js";
import {
	NATIVE_ARTIFACT_PROFILE_NAMES,
	resolveNativeArtifactPatchSelection,
} from "./native-profile.js";

test("native artifact profiles preserve cli-full and isolate Remote Control", () => {
	assert.deepEqual(NATIVE_ARTIFACT_PROFILE_NAMES, [
		"cli-full",
		"remote-control",
		"self-hosted-runner",
	]);

	const cli = resolveNativeArtifactPatchSelection("cli-full");
	assert.deepEqual(
		cli.receipt.selectedTags,
		registeredPatches.map(({ tag }) => tag),
	);
	assert.equal(cli.receipt.selectedTags.length, 44);

	const remote = resolveNativeArtifactPatchSelection("remote-control");
	assert.equal(remote.receipt.name, remoteControlCandidateProfile.name);
	assert.deepEqual(remote.receipt.selectedTags, REMOTE_CONTROL_CANDIDATE_TAGS);
	assert.equal(remote.patches.length, 30);
	assert.ok(remote.receipt.selectedTags.includes("tools-off-desktop"));
	assert.ok(!remote.receipt.selectedTags.includes("tools-off"));
	assert.ok(
		remote.patches.every((patch) => profilePatchCatalog.includes(patch)),
	);
	assert.equal(
		patchProfiles.some(({ name }) => name === "remote-control"),
		false,
	);

	const selfHosted = resolveNativeArtifactPatchSelection("self-hosted-runner");
	assert.equal(selfHosted.receipt.name, selfHostedRunnerCandidateProfile.name);
	assert.deepEqual(
		selfHosted.receipt.selectedTags,
		SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	);
	assert.equal(selfHosted.patches.length, 30);
	assert.ok(selfHosted.receipt.selectedTags.includes("tools-off-desktop"));
	assert.ok(!selfHosted.receipt.selectedTags.includes("tools-off"));
	assert.ok(
		selfHosted.patches.every((patch) => profilePatchCatalog.includes(patch)),
	);
	assert.equal(
		patchProfiles.some(({ name }) => name === "self-hosted-runner"),
		false,
	);
});

test("native artifact profile selection rejects non-build profiles", () => {
	assert.throws(
		() =>
			resolveNativeArtifactPatchSelection(
				"desktop-local" as "cli-full" | "remote-control" | "self-hosted-runner",
			),
		/unknown native artifact profile/i,
	);
});
