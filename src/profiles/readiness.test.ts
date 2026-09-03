import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patch } from "../types.js";
import type { PatchCapability } from "./contract.js";
import {
	buildPatchSurfaceReadiness,
	createPatchSupportEvidence,
	createPatchSurfaceReadiness,
	validatePatchSupportEvidence,
} from "./readiness.js";

test("Desktop-local readiness is blocked without manufacturing support", () => {
	const report = createPatchSurfaceReadiness("desktop-local");

	assert.equal(report.schemaVersion, 1);
	assert.equal(report.profile, "desktop-local");
	assert.equal(report.selectable, false);
	assert.equal(report.readiness, "blocked");
	assert.deepEqual(report.summary, {
		total: 45,
		supported: 0,
		probeRequired: 30,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(report.candidateTags.length, 30);
	assert.equal(report.candidateTags.includes("tools-off-desktop"), true);
	assert.equal(report.candidateTags.includes("tools-off"), false);
	assert.equal(report.requiredProbes.length > 0, true);
	assert.ok(
		report.requiredProbes.every(
			(probe) => probe.status === "not-run" && probe.tags.length > 0,
		),
	);
});

test("cli-full readiness remains selectable and preserves all tags", () => {
	const report = createPatchSurfaceReadiness("cli");

	assert.equal(report.profile, "cli-full");
	assert.equal(report.selectable, true);
	assert.equal(report.readiness, "ready");
	assert.deepEqual(report.summary, {
		total: 44,
		supported: 44,
		probeRequired: 0,
		excluded: 0,
		notAssessed: 0,
	});
	assert.deepEqual(report.candidateTags, report.supportedTags);
});

test("Remote Control readiness is classified but remains non-selectable", () => {
	const report = createPatchSurfaceReadiness("remote-control");

	assert.equal(report.profile, "remote-control");
	assert.equal(report.selectable, false);
	assert.equal(report.readiness, "blocked");
	assert.deepEqual(report.summary, {
		total: 45,
		supported: 0,
		probeRequired: 30,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(report.candidateTags.includes("read-bat"), true);
	assert.equal(report.candidateTags.includes("edit-extended"), true);
	assert.equal(report.candidateTags.includes("tools-off-desktop"), true);
	assert.equal(report.candidateTags.includes("tools-off"), false);
	assert.deepEqual(
		report.requiredProbes.map(({ id }) => id),
		[
			"remote-control-host-startup",
			"remote-control-tool-runtime",
			"remote-control-permission-input",
			"remote-control-read-semantics",
			"remote-control-read-presentation",
			"remote-control-edit-single-approval",
			"remote-control-edit-batch-approval",
			"remote-control-write-approval",
			"remote-control-tool-inventory",
			"remote-control-prompt-surface",
			"remote-control-artifact-read-semantics",
			"remote-control-agent-surface",
			"remote-control-command-surface",
			"remote-control-protocol-events",
			"remote-control-reconnect-resume",
			"remote-control-host-upgrade",
			"remote-control-patch-receipt",
		],
	);
});

test("self-hosted runner readiness is classified but remains non-selectable", () => {
	const report = createPatchSurfaceReadiness("self-hosted-runner");

	assert.equal(report.profile, "self-hosted-runner");
	assert.equal(report.selectable, false);
	assert.equal(report.readiness, "blocked");
	assert.deepEqual(report.summary, {
		total: 45,
		supported: 0,
		probeRequired: 30,
		excluded: 15,
		notAssessed: 0,
	});
	assert.equal(report.candidateTags.includes("read-bat"), true);
	assert.equal(report.candidateTags.includes("edit-extended"), true);
	assert.equal(report.candidateTags.includes("tools-off-desktop"), true);
	assert.equal(report.candidateTags.includes("tools-off"), false);
	assert.deepEqual(
		report.requiredProbes.map(({ id }) => id),
		[
			"self-hosted-runner-startup",
			"self-hosted-tool-runtime",
			"self-hosted-permission-input",
			"self-hosted-read-semantics",
			"self-hosted-read-presentation",
			"self-hosted-edit-single-approval",
			"self-hosted-edit-batch-approval",
			"self-hosted-write-approval",
			"self-hosted-tool-inventory",
			"self-hosted-prompt-surface",
			"self-hosted-artifact-read-semantics",
			"self-hosted-agent-surface",
			"self-hosted-command-surface",
			"self-hosted-protocol-events",
			"self-hosted-reconnect-resume",
			"self-hosted-runner-upgrade",
			"self-hosted-patch-receipt",
		],
	);
});

test("readiness rejects missing dependencies and selected surface conflicts", () => {
	const dependencyCatalog: Patch[] = [
		{ tag: "base", verify: () => true },
		{ tag: "consumer", requires: ["base"], verify: () => true },
	];
	const dependencyCapabilities: PatchCapability[] = [
		{
			tag: "base",
			effects: ["runtime"],
			support: {
				cli: { level: "supported" },
				"desktop-local": {
					level: "excluded",
					exclusionReason: "unsupported-runtime",
				},
				"remote-control": {
					level: "excluded",
					exclusionReason: "unsupported-runtime",
				},
				"self-hosted-runner": {
					level: "excluded",
					exclusionReason: "unsupported-runtime",
				},
			},
		},
		{
			tag: "consumer",
			effects: ["runtime"],
			support: {
				cli: { level: "supported" },
				"desktop-local": {
					level: "probe-required",
					requiredProbes: ["desktop-runtime-startup"],
				},
				"remote-control": {
					level: "probe-required",
					requiredProbes: ["remote-control-host-startup"],
				},
				"self-hosted-runner": {
					level: "probe-required",
					requiredProbes: ["self-hosted-runner-startup"],
				},
			},
		},
	];
	assert.throws(
		() =>
			buildPatchSurfaceReadiness({
				catalog: dependencyCatalog,
				capabilities: dependencyCapabilities,
				surface: "desktop-local",
			}),
		/consumer requires unavailable patch base/i,
	);

	const conflictCatalog: Patch[] = [
		{ tag: "first", verify: () => true },
		{ tag: "second", verify: () => true },
	];
	const conflictCapabilities: PatchCapability[] = [
		{
			tag: "first",
			effects: ["runtime"],
			support: {
				cli: { level: "supported" },
				"desktop-local": {
					level: "probe-required",
					requiredProbes: ["desktop-runtime-startup"],
					conflictsWith: ["second"],
				},
				"remote-control": {
					level: "probe-required",
					requiredProbes: ["remote-control-host-startup"],
					conflictsWith: ["second"],
				},
				"self-hosted-runner": {
					level: "probe-required",
					requiredProbes: ["self-hosted-runner-startup"],
					conflictsWith: ["second"],
				},
			},
		},
		{
			tag: "second",
			effects: ["runtime"],
			support: {
				cli: { level: "supported" },
				"desktop-local": {
					level: "probe-required",
					requiredProbes: ["desktop-runtime-startup"],
				},
				"remote-control": {
					level: "probe-required",
					requiredProbes: ["remote-control-host-startup"],
				},
				"self-hosted-runner": {
					level: "probe-required",
					requiredProbes: ["self-hosted-runner-startup"],
				},
			},
		},
	];
	assert.throws(
		() =>
			buildPatchSurfaceReadiness({
				catalog: conflictCatalog,
				capabilities: conflictCapabilities,
				surface: "desktop-local",
			}),
		/first conflicts with candidate patch second/i,
	);
});

test("support evidence is path-free, deterministic, and runtime validated", () => {
	const report = createPatchSurfaceReadiness("desktop-local");
	const evidence = createPatchSupportEvidence(report);

	assert.deepEqual(validatePatchSupportEvidence(evidence), evidence);
	assert.doesNotMatch(
		JSON.stringify(evidence),
		/(?:\/home\/|[A-Z]:\\|binaryPath|cacheRoot|processId|sessionId)/,
	);
	assert.throws(
		() =>
			validatePatchSupportEvidence({
				...evidence,
				readiness: "invented",
			}),
		/readiness/i,
	);
});
