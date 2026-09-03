import assert from "node:assert/strict";
import { test } from "node:test";
import { profilePatchCatalog, registeredPatches } from "../patches/index.js";
import { cliFullProfile } from "../profiles/cli-full.js";
import type { PatchProfile } from "../profiles/contract.js";
import { desktopLocalCandidateProfile } from "../profiles/desktop-local.js";
import { remoteControlCandidateProfile } from "../profiles/remote-control.js";
import {
	NATIVE_ARTIFACT_PLATFORMS,
	VERSION_LANES,
} from "../targets/contract.js";
import type { Patch } from "../types.js";
import {
	patchSelectionOverridesFromEnv,
	resolvePatchSelection,
} from "./selection.js";

const BASELINE_CLI_FULL_TAGS = [
	"bash-prompt",
	"built-in-agent-prompt",
	"claude-api-scope",
	"claudemd-strong",
	"memory-prompt-soften",
	"mcp-server-name",
	"session-guidance",
	"todo-use",
	"cache-tail-policy",
	"child-network-env",
	"edit-extended",
	"effort-stack",
	"feature-flags",
	"file-link-targets",
	"billing-label",
	"image-limits",
	"plan-diff-ui",
	"plan-compact-execute",
	"tools-off",
	"no-autoupdate",
	"read-bat",
	"agents-off",
	"commands-off",
	"configured-model-catalog",
	"lsp-multi-server",
	"lsp-filename-schema",
	"no-collapse",
	"skill-paths-invoke",
	"skill-global-paths",
	"skill-activation-notice",
	"skill-listing-ui",
	"agent-listing-ui",
	"subagent-system-prompt",
	"model-aliases",
	"model-picker-session-only",
	"subagent-model-tag",
	"tab-queue",
	"session-mem",
	"model-context-metadata",
	"sys-prompt-file",
	"limits",
	"prompt-dash-style",
	"workflow-safety",
	"signature",
] as const;

test("canonical native platform inventory uses official manifest keys", () => {
	assert.deepEqual(NATIVE_ARTIFACT_PLATFORMS, [
		"linux-x64",
		"linux-arm64",
		"linux-x64-musl",
		"linux-arm64-musl",
		"darwin-x64",
		"darwin-arm64",
		"win32-x64",
		"win32-arm64",
	]);
});

test("version lanes distinguish CLI updates from pinned target versions", () => {
	assert.deepEqual(VERSION_LANES, [
		"cli-latest",
		"desktop-current",
		"runner-pinned",
	]);
});

test("cli-full selection preserves the current patch registration order", () => {
	const selection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: cliFullProfile,
	});

	assert.equal(registeredPatches.length, 44);
	assert.equal(profilePatchCatalog.length, 45);
	assert.equal(
		registeredPatches.some(({ tag }) => tag === "tools-off-desktop"),
		false,
	);
	assert.deepEqual(
		profilePatchCatalog.slice(18, 20).map(({ tag }) => tag),
		["tools-off", "tools-off-desktop"],
	);
	assert.deepEqual(cliFullProfile.includes, BASELINE_CLI_FULL_TAGS);
	assert.deepEqual(
		selection.patches.map((patch) => patch.tag),
		BASELINE_CLI_FULL_TAGS,
	);
	assert.equal(selection.receipt.name, "cli-full");
});

test("Desktop-local candidate selection uses only the reserved profile catalog", () => {
	const selection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: desktopLocalCandidateProfile,
	});

	assert.equal(selection.receipt.name, "desktop-local");
	assert.equal(selection.receipt.surface, "desktop-local");
	assert.equal(selection.receipt.selectedTags.length, 29);
	assert.equal(selection.receipt.exclusions.length, 16);
	assert.equal(selection.receipt.requiredProbes.length, 17);
	assert.equal(selection.receipt.selectedTags.includes("tools-off"), false);
	assert.equal(selection.receipt.selectedTags.includes("effort-stack"), false);
	assert.deepEqual(
		selection.receipt.exclusions.find(({ tag }) => tag === "effort-stack"),
		{ tag: "effort-stack", reason: "unsupported-runtime" },
	);
	assert.equal(
		selection.receipt.selectedTags.includes("tools-off-desktop"),
		true,
	);
});

test("Remote Control candidate does not change the exact cli-full roster", () => {
	const remoteSelection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: remoteControlCandidateProfile,
	});
	const cliSelection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: cliFullProfile,
	});

	assert.equal(remoteSelection.receipt.name, "remote-control");
	assert.equal(remoteSelection.receipt.selectedTags.length, 30);
	assert.equal(remoteSelection.receipt.exclusions.length, 15);
	assert.deepEqual(
		cliSelection.patches.map(({ tag }) => tag),
		BASELINE_CLI_FULL_TAGS,
	);
});

test("environment overrides are evaluated independently for each selection", () => {
	const includeSelection = resolvePatchSelection({
		catalog: registeredPatches,
		profile: cliFullProfile,
		overrides: patchSelectionOverridesFromEnv({
			CLAUDE_PATCHER_INCLUDE_TAGS: " read-bat, signature,read-bat ",
		}),
	});
	const excludeSelection = resolvePatchSelection({
		catalog: registeredPatches,
		profile: cliFullProfile,
		overrides: patchSelectionOverridesFromEnv({
			CLAUDE_PATCHER_EXCLUDE_TAGS: "signature, read-bat",
		}),
	});
	const defaultSelection = resolvePatchSelection({
		catalog: registeredPatches,
		profile: cliFullProfile,
		overrides: patchSelectionOverridesFromEnv({}),
	});

	assert.deepEqual(
		includeSelection.patches.map((patch) => patch.tag),
		["read-bat", "signature"],
	);
	assert.equal(
		excludeSelection.patches.some(
			(patch) => patch.tag === "read-bat" || patch.tag === "signature",
		),
		false,
	);
	assert.deepEqual(
		defaultSelection.patches.map((patch) => patch.tag),
		BASELINE_CLI_FULL_TAGS,
	);
});

test("selection rejects unknown override tags", () => {
	assert.throws(
		() =>
			resolvePatchSelection({
				catalog: registeredPatches,
				profile: cliFullProfile,
				overrides: { includeTags: ["typo"] },
			}),
		/unknown include override patch tag: typo/i,
	);
	assert.throws(
		() =>
			resolvePatchSelection({
				catalog: registeredPatches,
				profile: cliFullProfile,
				overrides: { excludeTags: ["typo"] },
			}),
		/unknown exclude override patch tag: typo/i,
	);
});

test("selection rejects override tags outside the selected profile", () => {
	assert.throws(
		() =>
			resolvePatchSelection({
				catalog: profilePatchCatalog,
				profile: cliFullProfile,
				overrides: { includeTags: ["tools-off-desktop"] },
			}),
		/include override patch tag is outside profile cli-full: tools-off-desktop/i,
	);
});

test("selection rejects an empty effective patch roster", () => {
	assert.throws(
		() =>
			resolvePatchSelection({
				catalog: registeredPatches,
				profile: cliFullProfile,
				overrides: {
					includeTags: ["read-bat"],
					excludeTags: ["read-bat"],
				},
			}),
		/patch selection resolved to zero patches/i,
	);
});

test("selection rejects a patch whose required tag is absent", () => {
	const catalog: Patch[] = [
		{ tag: "required", verify: () => true },
		{ tag: "consumer", requires: ["required"], verify: () => true },
	];
	const profile = {
		name: "cli-full",
		surface: "cli",
		includes: ["consumer"],
		excludes: [],
		requiredProbes: [],
	} as const satisfies PatchProfile;

	assert.throws(
		() => resolvePatchSelection({ catalog, profile }),
		/consumer requires missing patch required/,
	);
});

test("selection rejects a selected patch conflict", () => {
	const catalog: Patch[] = [
		{ tag: "first", conflicts: ["second"], verify: () => true },
		{ tag: "second", verify: () => true },
	];
	const profile = {
		name: "cli-full",
		surface: "cli",
		includes: ["first", "second"],
		excludes: [],
		requiredProbes: [],
	} as const satisfies PatchProfile;

	assert.throws(
		() => resolvePatchSelection({ catalog, profile }),
		/first conflicts with selected patch second/,
	);
});
