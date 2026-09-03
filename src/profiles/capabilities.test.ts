import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog, registeredPatches } from "../patches/index.js";
import type { Patch } from "../types.js";
import {
	patchCapabilities,
	profilePatchCapabilities,
	validatePatchCapabilityCatalog,
} from "./capabilities.js";
import type { PatchCapability } from "./contract.js";

test("every registered patch has one ordered capability record", () => {
	validatePatchCapabilityCatalog(registeredPatches, patchCapabilities);

	assert.equal(patchCapabilities.length, 44);
	assert.deepEqual(
		patchCapabilities.map(({ tag }) => tag),
		registeredPatches.map(({ tag }) => tag),
	);
	assert.ok(patchCapabilities.every(({ effects }) => effects.length > 0));
	assert.ok(
		patchCapabilities.every(
			({ support }) => support.cli?.level === "supported",
		),
	);
});

test("the profile catalog adds one ordered Desktop tool-policy variant", () => {
	validatePatchCapabilityCatalog(profilePatchCatalog, profilePatchCapabilities);

	assert.equal(profilePatchCapabilities.length, 45);
	assert.deepEqual(
		profilePatchCapabilities.map(({ tag }) => tag),
		profilePatchCatalog.map(({ tag }) => tag),
	);
	assert.deepEqual(
		profilePatchCapabilities.find(({ tag }) => tag === "tools-off-desktop"),
		{
			tag: "tools-off-desktop",
			effects: ["prompt", "tool-schema", "runtime"],
			support: {
				cli: { level: "supported" },
				"desktop-local": {
					level: "probe-required",
					requiredProbes: [
						"desktop-tool-inventory",
						"desktop-prompt-surface",
						"desktop-artifact-read-semantics",
						"desktop-restart-resume",
					],
				},
				"remote-control": {
					level: "probe-required",
					requiredProbes: [
						"remote-control-tool-inventory",
						"remote-control-prompt-surface",
						"remote-control-artifact-read-semantics",
						"remote-control-reconnect-resume",
					],
				},
				"self-hosted-runner": {
					level: "probe-required",
					requiredProbes: [
						"self-hosted-tool-inventory",
						"self-hosted-prompt-surface",
						"self-hosted-artifact-read-semantics",
						"self-hosted-reconnect-resume",
					],
				},
			},
		},
	);
});

test("Desktop-local classifications are complete and conservative", () => {
	const desktop = profilePatchCapabilities.map(
		(capability) => capability.support["desktop-local"],
	);
	assert.ok(desktop.every(Boolean));
	assert.equal(
		desktop.filter((support) => support?.level === "supported").length,
		0,
	);
	assert.equal(
		desktop.filter((support) => support?.level === "probe-required").length,
		30,
	);
	assert.equal(
		desktop.filter((support) => support?.level === "excluded").length,
		15,
	);
});

test("Remote Control classifications are complete and conservative", () => {
	const remote = profilePatchCapabilities.map(
		(capability) => capability.support["remote-control"],
	);
	assert.ok(remote.every(Boolean));
	assert.equal(
		remote.filter((support) => support?.level === "supported").length,
		0,
	);
	assert.equal(
		remote.filter((support) => support?.level === "probe-required").length,
		30,
	);
	assert.equal(
		remote.filter((support) => support?.level === "excluded").length,
		15,
	);
});

test("self-hosted classifications are complete and conservative", () => {
	const runner = profilePatchCapabilities.map(
		(capability) => capability.support["self-hosted-runner"],
	);
	assert.ok(runner.every(Boolean));
	assert.equal(
		runner.filter((support) => support?.level === "supported").length,
		0,
	);
	assert.equal(
		runner.filter((support) => support?.level === "probe-required").length,
		30,
	);
	assert.equal(
		runner.filter((support) => support?.level === "excluded").length,
		15,
	);
});

test("Read, Edit, and tool policy expose their exact stock-client gates", () => {
	const read = patchCapabilities.find(({ tag }) => tag === "read-bat");
	const edit = patchCapabilities.find(({ tag }) => tag === "edit-extended");
	const tools = patchCapabilities.find(({ tag }) => tag === "tools-off");
	const desktopTools = profilePatchCapabilities.find(
		({ tag }) => tag === "tools-off-desktop",
	);

	assert.deepEqual(read?.effects, [
		"prompt",
		"tool-schema",
		"runtime",
		"terminal-rendering",
	]);
	assert.deepEqual(read?.support["desktop-local"]?.requiredProbes, [
		"desktop-packaged-sdk-permission-input",
		"desktop-read-semantics",
		"desktop-read-card",
	]);
	assert.equal(read?.support["remote-control"]?.level, "probe-required");
	assert.deepEqual(read?.support["remote-control"]?.requiredProbes, [
		"remote-control-permission-input",
		"remote-control-read-semantics",
		"remote-control-read-presentation",
	]);
	assert.equal(edit?.support["desktop-local"]?.level, "probe-required");
	assert.deepEqual(edit?.support["desktop-local"]?.requiredProbes, [
		"desktop-packaged-sdk-permission-input",
		"desktop-edit-single-approval",
		"desktop-edit-batch-approval",
		"desktop-write-approval",
		"desktop-restart-resume",
	]);
	assert.equal(edit?.support["remote-control"]?.level, "probe-required");
	assert.deepEqual(edit?.support["remote-control"]?.requiredProbes, [
		"remote-control-permission-input",
		"remote-control-edit-single-approval",
		"remote-control-edit-batch-approval",
		"remote-control-write-approval",
		"remote-control-reconnect-resume",
	]);
	assert.equal(read?.support["self-hosted-runner"]?.level, "probe-required");
	assert.deepEqual(read?.support["self-hosted-runner"]?.requiredProbes, [
		"self-hosted-permission-input",
		"self-hosted-read-semantics",
		"self-hosted-read-presentation",
	]);
	assert.equal(edit?.support["self-hosted-runner"]?.level, "probe-required");
	assert.deepEqual(edit?.support["self-hosted-runner"]?.requiredProbes, [
		"self-hosted-permission-input",
		"self-hosted-edit-single-approval",
		"self-hosted-edit-batch-approval",
		"self-hosted-write-approval",
		"self-hosted-reconnect-resume",
	]);
	assert.deepEqual(tools?.support["desktop-local"], {
		level: "excluded",
		exclusionReason: "conflicting-tool-policy",
		conflictsWith: ["edit-extended"],
	});
	assert.deepEqual(desktopTools?.support["desktop-local"], {
		level: "probe-required",
		requiredProbes: [
			"desktop-tool-inventory",
			"desktop-prompt-surface",
			"desktop-artifact-read-semantics",
			"desktop-restart-resume",
		],
	});
	assert.deepEqual(tools?.support["remote-control"], {
		level: "excluded",
		exclusionReason: "conflicting-tool-policy",
		conflictsWith: ["edit-extended"],
	});
	assert.deepEqual(desktopTools?.support["remote-control"], {
		level: "probe-required",
		requiredProbes: [
			"remote-control-tool-inventory",
			"remote-control-prompt-surface",
			"remote-control-artifact-read-semantics",
			"remote-control-reconnect-resume",
		],
	});
	assert.deepEqual(tools?.support["self-hosted-runner"], {
		level: "excluded",
		exclusionReason: "conflicting-tool-policy",
		conflictsWith: ["edit-extended"],
	});
	assert.deepEqual(desktopTools?.support["self-hosted-runner"], {
		level: "probe-required",
		requiredProbes: [
			"self-hosted-tool-inventory",
			"self-hosted-prompt-surface",
			"self-hosted-artifact-read-semantics",
			"self-hosted-reconnect-resume",
		],
	});
});

test("tools-off-desktop requires Artifact read semantics on every stock-client surface", () => {
	const desktopTools = profilePatchCapabilities.find(
		({ tag }) => tag === "tools-off-desktop",
	);

	assert.deepEqual(desktopTools?.support["desktop-local"]?.requiredProbes, [
		"desktop-tool-inventory",
		"desktop-prompt-surface",
		"desktop-artifact-read-semantics",
		"desktop-restart-resume",
	]);
	assert.deepEqual(desktopTools?.support["remote-control"]?.requiredProbes, [
		"remote-control-tool-inventory",
		"remote-control-prompt-surface",
		"remote-control-artifact-read-semantics",
		"remote-control-reconnect-resume",
	]);
	assert.deepEqual(
		desktopTools?.support["self-hosted-runner"]?.requiredProbes,
		[
			"self-hosted-tool-inventory",
			"self-hosted-prompt-surface",
			"self-hosted-artifact-read-semantics",
			"self-hosted-reconnect-resume",
		],
	);
});

test("capability validation rejects incomplete and invalid catalogs", () => {
	const catalog: Patch[] = [
		{ tag: "first", verify: () => true },
		{ tag: "second", verify: () => true },
	];
	const valid: PatchCapability = {
		tag: "first",
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
	};

	assert.throws(
		() => validatePatchCapabilityCatalog(catalog, [valid]),
		/missing capability.*second/i,
	);
	assert.throws(
		() =>
			validatePatchCapabilityCatalog(
				[catalog[0]],
				[valid, { ...valid, tag: "unknown" }],
			),
		/unknown capability.*unknown/i,
	);
	assert.throws(
		() =>
			validatePatchCapabilityCatalog(
				[catalog[0]],
				[
					{
						...valid,
						support: {
							...valid.support,
							"desktop-local": { level: "probe-required" },
						},
					},
				],
			),
		/requires at least one probe/i,
	);
});
