import { profilePatchCatalog, registeredPatches } from "../patches/index.js";
import type { RuntimeSurface } from "../targets/contract.js";
import type { Patch } from "../types.js";
import {
	type DesktopPatchProbeId,
	PATCH_EFFECTS,
	PATCH_PROBE_IDS,
	PATCH_SUPPORT_LEVELS,
	type PatchCapability,
	type PatchEffect,
	type PatchExclusionReason,
	type PatchProbeDefinition,
	type PatchProbeId,
	type PatchSurfaceSupport,
	type RemoteControlPatchProbeId,
	type SelfHostedRunnerPatchProbeId,
} from "./contract.js";

const CAPABILITY_SURFACES = [
	"cli",
	"desktop-local",
	"desktop-wsl",
	"desktop-ssh",
	"remote-control",
	"self-hosted-runner",
] as const satisfies readonly RuntimeSurface[];

type PatchCapabilityDefinition = Omit<PatchCapability, "tag">;

const REMOTE_PROBE_BY_DESKTOP_PROBE: Record<
	DesktopPatchProbeId,
	RemoteControlPatchProbeId
> = {
	"desktop-runtime-startup": "remote-control-host-startup",
	"desktop-tool-runtime": "remote-control-tool-runtime",
	"desktop-packaged-sdk-permission-input": "remote-control-permission-input",
	"desktop-read-semantics": "remote-control-read-semantics",
	"desktop-read-card": "remote-control-read-presentation",
	"desktop-edit-single-approval": "remote-control-edit-single-approval",
	"desktop-edit-batch-approval": "remote-control-edit-batch-approval",
	"desktop-write-approval": "remote-control-write-approval",
	"desktop-tool-inventory": "remote-control-tool-inventory",
	"desktop-prompt-surface": "remote-control-prompt-surface",
	"desktop-agent-surface": "remote-control-agent-surface",
	"desktop-command-surface": "remote-control-command-surface",
	"desktop-protocol-events": "remote-control-protocol-events",
	"desktop-restart-resume": "remote-control-reconnect-resume",
	"desktop-update-replacement": "remote-control-host-upgrade",
	"desktop-patch-receipt": "remote-control-patch-receipt",
};

const SELF_HOSTED_PROBE_BY_DESKTOP_PROBE: Record<
	DesktopPatchProbeId,
	SelfHostedRunnerPatchProbeId
> = {
	"desktop-runtime-startup": "self-hosted-runner-startup",
	"desktop-tool-runtime": "self-hosted-tool-runtime",
	"desktop-packaged-sdk-permission-input": "self-hosted-permission-input",
	"desktop-read-semantics": "self-hosted-read-semantics",
	"desktop-read-card": "self-hosted-read-presentation",
	"desktop-edit-single-approval": "self-hosted-edit-single-approval",
	"desktop-edit-batch-approval": "self-hosted-edit-batch-approval",
	"desktop-write-approval": "self-hosted-write-approval",
	"desktop-tool-inventory": "self-hosted-tool-inventory",
	"desktop-prompt-surface": "self-hosted-prompt-surface",
	"desktop-agent-surface": "self-hosted-agent-surface",
	"desktop-command-surface": "self-hosted-command-surface",
	"desktop-protocol-events": "self-hosted-protocol-events",
	"desktop-restart-resume": "self-hosted-reconnect-resume",
	"desktop-update-replacement": "self-hosted-runner-upgrade",
	"desktop-patch-receipt": "self-hosted-patch-receipt",
};

const supported = { level: "supported" } as const;

function probeRequired(
	...requiredProbes: readonly PatchProbeId[]
): PatchSurfaceSupport {
	return { level: "probe-required", requiredProbes };
}

function excluded(
	exclusionReason: PatchExclusionReason,
	conflictsWith?: readonly string[],
): PatchSurfaceSupport {
	return {
		level: "excluded",
		exclusionReason,
		...(conflictsWith ? { conflictsWith } : {}),
	};
}

function remoteControlSupportFromDesktop(
	desktopLocal: PatchSurfaceSupport,
): PatchSurfaceSupport {
	if (desktopLocal.level === "excluded") {
		return excluded(
			desktopLocal.exclusionReason ?? "unsupported-runtime",
			desktopLocal.conflictsWith,
		);
	}
	if (desktopLocal.level === "supported") {
		throw new Error(
			"Remote Control support requires an explicit review when Desktop support becomes unconditional",
		);
	}
	const remoteProbes = (desktopLocal.requiredProbes ?? []).map((probe) => {
		const mapped = REMOTE_PROBE_BY_DESKTOP_PROBE[probe as DesktopPatchProbeId];
		if (!mapped) {
			throw new Error(`Remote Control has no probe mapping for ${probe}`);
		}
		return mapped;
	});
	return probeRequired(...remoteProbes);
}

function selfHostedSupportFromDesktop(
	desktopLocal: PatchSurfaceSupport,
): PatchSurfaceSupport {
	if (desktopLocal.level === "excluded") {
		return excluded(
			desktopLocal.exclusionReason ?? "unsupported-runtime",
			desktopLocal.conflictsWith,
		);
	}
	if (desktopLocal.level === "supported") {
		throw new Error(
			"Self-hosted support requires an explicit review when Desktop support becomes unconditional",
		);
	}
	const selfHostedProbes = (desktopLocal.requiredProbes ?? []).map((probe) => {
		const mapped =
			SELF_HOSTED_PROBE_BY_DESKTOP_PROBE[probe as DesktopPatchProbeId];
		if (!mapped) {
			throw new Error(`Self-hosted runner has no probe mapping for ${probe}`);
		}
		return mapped;
	});
	return probeRequired(...selfHostedProbes);
}

function capability(
	effects: readonly PatchEffect[],
	desktopLocal: PatchSurfaceSupport,
): PatchCapabilityDefinition {
	return {
		effects,
		support: {
			cli: supported,
			"desktop-local": desktopLocal,
			"remote-control": remoteControlSupportFromDesktop(desktopLocal),
			"self-hosted-runner": selfHostedSupportFromDesktop(desktopLocal),
		},
	};
}

const CAPABILITY_DEFINITIONS: Record<string, PatchCapabilityDefinition> = {
	"shell-quote-fix": capability(
		["runtime"],
		probeRequired("desktop-tool-runtime"),
	),
	"bash-prompt": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface"),
	),
	"built-in-agent-prompt": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface", "desktop-agent-surface"),
	),
	"claude-api-scope": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface"),
	),
	"claudemd-strong": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface"),
	),
	"memory-prompt-soften": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface"),
	),
	"mcp-server-name": capability(
		["runtime"],
		probeRequired("desktop-tool-runtime", "desktop-tool-inventory"),
	),
	"session-guidance": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface", "desktop-restart-resume"),
	),
	"todo-use": capability(["prompt"], probeRequired("desktop-prompt-surface")),
	"cache-tail-policy": capability(
		["runtime", "protocol"],
		probeRequired(
			"desktop-runtime-startup",
			"desktop-protocol-events",
			"desktop-restart-resume",
		),
	),
	"child-network-env": capability(
		["runtime", "protocol"],
		excluded("provider-routing"),
	),
	"edit-extended": capability(
		["prompt", "tool-schema", "runtime", "terminal-rendering"],
		probeRequired(
			"desktop-packaged-sdk-permission-input",
			"desktop-edit-single-approval",
			"desktop-edit-batch-approval",
			"desktop-write-approval",
			"desktop-restart-resume",
		),
	),
	"effort-stack": capability(
		["prompt", "runtime", "terminal-rendering"],
		probeRequired(
			"desktop-runtime-startup",
			"desktop-agent-surface",
			"desktop-restart-resume",
		),
	),
	"feature-flags": capability(
		["runtime"],
		probeRequired("desktop-runtime-startup", "desktop-tool-inventory"),
	),
	"file-link-targets": capability(
		["runtime", "terminal-rendering"],
		excluded("terminal-only"),
	),
	"billing-label": capability(
		["terminal-rendering"],
		excluded("terminal-only"),
	),
	"image-limits": capability(
		["runtime", "protocol"],
		probeRequired("desktop-tool-runtime", "desktop-protocol-events"),
	),
	"plan-diff-ui": capability(["terminal-rendering"], excluded("terminal-only")),
	"plan-compact-execute": capability(
		["runtime", "terminal-rendering"],
		excluded("terminal-only"),
	),
	"tools-off": capability(
		["prompt", "tool-schema", "runtime"],
		excluded("conflicting-tool-policy", ["edit-extended"]),
	),
	"tools-off-desktop": capability(
		["prompt", "tool-schema", "runtime"],
		probeRequired(
			"desktop-tool-inventory",
			"desktop-prompt-surface",
			"desktop-restart-resume",
		),
	),
	"no-autoupdate": capability(
		["runtime"],
		probeRequired("desktop-update-replacement", "desktop-restart-resume"),
	),
	"read-bat": capability(
		["prompt", "tool-schema", "runtime", "terminal-rendering"],
		probeRequired(
			"desktop-packaged-sdk-permission-input",
			"desktop-read-semantics",
			"desktop-read-card",
		),
	),
	"agents-off": capability(
		["prompt", "runtime"],
		probeRequired(
			"desktop-agent-surface",
			"desktop-tool-inventory",
			"desktop-restart-resume",
		),
	),
	"commands-off": capability(
		["runtime"],
		probeRequired("desktop-command-surface", "desktop-restart-resume"),
	),
	"configured-model-catalog": capability(
		["runtime", "protocol", "terminal-rendering"],
		excluded("provider-routing"),
	),
	"lsp-multi-server": capability(
		["runtime", "protocol"],
		probeRequired("desktop-tool-runtime", "desktop-protocol-events"),
	),
	"lsp-filename-schema": capability(
		["tool-schema", "runtime"],
		probeRequired("desktop-tool-runtime"),
	),
	"no-collapse": capability(["terminal-rendering"], excluded("terminal-only")),
	"skill-paths-invoke": capability(
		["prompt", "runtime"],
		probeRequired("desktop-agent-surface", "desktop-restart-resume"),
	),
	"skill-global-paths": capability(
		["tool-schema", "runtime"],
		probeRequired("desktop-agent-surface", "desktop-restart-resume"),
	),
	"skill-activation-notice": capability(
		["terminal-rendering"],
		excluded("terminal-only"),
	),
	"skill-listing-ui": capability(
		["prompt", "runtime", "terminal-rendering"],
		probeRequired(
			"desktop-agent-surface",
			"desktop-protocol-events",
			"desktop-restart-resume",
		),
	),
	"agent-listing-ui": capability(
		["terminal-rendering"],
		excluded("terminal-only"),
	),
	"subagent-system-prompt": capability(
		["prompt", "runtime"],
		probeRequired(
			"desktop-prompt-surface",
			"desktop-agent-surface",
			"desktop-restart-resume",
		),
	),
	"model-aliases": capability(
		["runtime", "protocol", "terminal-rendering"],
		excluded("provider-routing"),
	),
	"model-picker-session-only": capability(
		["runtime", "terminal-rendering"],
		excluded("terminal-only"),
	),
	"subagent-model-tag": capability(
		["runtime", "protocol", "terminal-rendering"],
		excluded("provider-routing"),
	),
	"tab-queue": capability(
		["runtime", "terminal-rendering"],
		excluded("terminal-only"),
	),
	"session-mem": capability(
		["runtime"],
		probeRequired("desktop-runtime-startup", "desktop-restart-resume"),
	),
	"model-context-metadata": capability(
		["runtime", "protocol"],
		excluded("provider-routing"),
	),
	"sys-prompt-file": capability(
		["prompt", "runtime"],
		probeRequired("desktop-prompt-surface", "desktop-restart-resume"),
	),
	limits: capability(
		["tool-schema", "runtime"],
		probeRequired("desktop-read-semantics", "desktop-tool-runtime"),
	),
	"prompt-dash-style": capability(
		["prompt"],
		probeRequired("desktop-prompt-surface"),
	),
	"workflow-safety": capability(
		["runtime", "protocol"],
		probeRequired(
			"desktop-agent-surface",
			"desktop-protocol-events",
			"desktop-restart-resume",
		),
	),
	signature: capability(
		["runtime", "protocol", "terminal-rendering"],
		probeRequired("desktop-patch-receipt", "desktop-runtime-startup"),
	),
};

export const patchProbeDefinitions: readonly PatchProbeDefinition[] = [
	{
		id: "desktop-runtime-startup",
		label: "Desktop Code startup",
		evidenceRequired:
			"A consented patched local Code session initializes without an application or runtime failure.",
	},
	{
		id: "desktop-tool-runtime",
		label: "Desktop tool runtime semantics",
		evidenceRequired:
			"The affected built-in tool executes its patched semantics through Desktop local Code.",
	},
	{
		id: "desktop-packaged-sdk-permission-input",
		label: "Packaged Agent SDK permission input",
		evidenceRequired:
			"The exact packaged SDK callback shape preserves the complete tool input before an approval decision.",
	},
	{
		id: "desktop-read-semantics",
		label: "Read semantics",
		evidenceRequired:
			"Range, whitespace, bounded large-file, and stock media behavior return complete and correct results.",
	},
	{
		id: "desktop-read-card",
		label: "Read card intent",
		evidenceRequired:
			"Desktop presents enough Read range and whitespace intent for the user to understand the operation.",
	},
	{
		id: "desktop-edit-single-approval",
		label: "Single Edit approval",
		evidenceRequired:
			"Desktop shows the complete stock single-edit intent and exact diff before approval where approval is required.",
	},
	{
		id: "desktop-edit-batch-approval",
		label: "Batch Edit approval",
		evidenceRequired:
			"Desktop shows every edits[] change as a complete exact diff before approval in every offered permission mode.",
	},
	{
		id: "desktop-write-approval",
		label: "Write approval",
		evidenceRequired:
			"Desktop shows complete create and overwrite intent while preserving modified-since-read protection.",
	},
	{
		id: "desktop-tool-inventory",
		label: "Tool inventory",
		evidenceRequired:
			"The live tool inventory exactly matches the candidate profile and contains no disabled-tool prompt leaks.",
	},
	{
		id: "desktop-prompt-surface",
		label: "Prompt surfaces",
		evidenceRequired:
			"Exported and live Desktop prompt surfaces contain the intended policy without terminal-only or disabled-tool contradictions.",
	},
	{
		id: "desktop-agent-surface",
		label: "Agent and skill surfaces",
		evidenceRequired:
			"Agent, subagent, workflow, skill, and related inventory behavior matches the candidate profile.",
	},
	{
		id: "desktop-command-surface",
		label: "Command surface",
		evidenceRequired:
			"Desktop exposes exactly the command inventory intended by the candidate profile.",
	},
	{
		id: "desktop-protocol-events",
		label: "Protocol event projection",
		evidenceRequired:
			"Stock-compatible events carry complete semantic state without depending on terminal renderers.",
	},
	{
		id: "desktop-restart-resume",
		label: "Restart and resume",
		evidenceRequired:
			"Desktop restart and session resume preserve the candidate behavior and do not revive excluded state.",
	},
	{
		id: "desktop-update-replacement",
		label: "Update replacement policy",
		evidenceRequired:
			"A Desktop-managed replacement is detected and follows the explicit stock, repatch, or freeze policy without silent drift.",
	},
	{
		id: "desktop-patch-receipt",
		label: "Patched artifact receipt",
		evidenceRequired:
			"The exact activated candidate reports the expected ordered profile roster separately from its upstream version.",
	},
	{
		id: "remote-control-host-startup",
		label: "Remote Control host startup",
		evidenceRequired:
			"A consented session starts from an exact matching-host remote-control profile receipt without opening an inbound listener.",
	},
	{
		id: "remote-control-tool-runtime",
		label: "Remote Control tool runtime semantics",
		evidenceRequired:
			"The affected built-in tool executes its patched semantics on the host while a stock remote client remains synchronized.",
	},
	{
		id: "remote-control-permission-input",
		label: "Remote Control permission input",
		evidenceRequired:
			"The remote approval path preserves complete tool input before a decision without protocol interception.",
	},
	{
		id: "remote-control-read-semantics",
		label: "Remote Control Read semantics",
		evidenceRequired:
			"Range, whitespace, bounded large-file, and stock media behavior return complete and correct host results.",
	},
	{
		id: "remote-control-read-presentation",
		label: "Remote Control Read presentation",
		evidenceRequired:
			"Each claimed stock client presents enough range and whitespace intent for the user to understand the operation.",
	},
	{
		id: "remote-control-edit-single-approval",
		label: "Remote Control single Edit approval",
		evidenceRequired:
			"Each claimed stock client shows the complete single-edit intent and exact diff before approval where required.",
	},
	{
		id: "remote-control-edit-batch-approval",
		label: "Remote Control batch Edit approval",
		evidenceRequired:
			"Each claimed stock client shows every edits[] change as a complete exact diff before approval.",
	},
	{
		id: "remote-control-write-approval",
		label: "Remote Control Write approval",
		evidenceRequired:
			"Each claimed stock client shows complete create and overwrite intent while the host preserves modified-since-read protection.",
	},
	{
		id: "remote-control-tool-inventory",
		label: "Remote Control tool inventory",
		evidenceRequired:
			"The synchronized live tool inventory matches the candidate profile and contains no disabled-tool prompt leaks.",
	},
	{
		id: "remote-control-prompt-surface",
		label: "Remote Control prompt surfaces",
		evidenceRequired:
			"Exported and live host prompts contain the intended policy without terminal-only or disabled-tool contradictions.",
	},
	{
		id: "remote-control-agent-surface",
		label: "Remote Control agent and skill surfaces",
		evidenceRequired:
			"Agent, subagent, workflow, skill, and progress behavior stays synchronized on every claimed client.",
	},
	{
		id: "remote-control-command-surface",
		label: "Remote Control command surface",
		evidenceRequired:
			"The host and connected clients expose only the command behavior intended by the candidate profile.",
	},
	{
		id: "remote-control-protocol-events",
		label: "Remote Control protocol event projection",
		evidenceRequired:
			"Upstream-owned events carry complete semantic state without depending on terminal-only renderers or custom interception.",
	},
	{
		id: "remote-control-reconnect-resume",
		label: "Remote Control reconnect and resume",
		evidenceRequired:
			"Disconnect, reconnect, rename, and supported resume paths preserve the host session and synchronized state.",
	},
	{
		id: "remote-control-host-upgrade",
		label: "Remote Control host upgrade policy",
		evidenceRequired:
			"A host binary replacement is detected and follows the explicit rebuild or rollback policy without silent profile drift.",
	},
	{
		id: "remote-control-patch-receipt",
		label: "Remote Control patched host receipt",
		evidenceRequired:
			"The exact matching-host binary reports the expected ordered remote-control profile roster separately from its upstream version.",
	},
	{
		id: "self-hosted-runner-startup",
		label: "Self-hosted runner and child startup",
		evidenceRequired:
			"A registered matching-host runner starts a session child from the exact pinned candidate without a runner or child failure.",
	},
	{
		id: "self-hosted-tool-runtime",
		label: "Self-hosted tool runtime semantics",
		evidenceRequired:
			"The affected built-in tool executes its patched semantics in a real runner child while the originating stock client remains synchronized.",
	},
	{
		id: "self-hosted-permission-input",
		label: "Self-hosted permission input",
		evidenceRequired:
			"The cloud-session approval path preserves complete tool input before a decision without replacing the upstream control channel.",
	},
	{
		id: "self-hosted-read-semantics",
		label: "Self-hosted Read semantics",
		evidenceRequired:
			"Range, whitespace, bounded large-file, and stock media behavior return complete and correct results from the runner child.",
	},
	{
		id: "self-hosted-read-presentation",
		label: "Self-hosted Read presentation",
		evidenceRequired:
			"Each claimed stock client presents enough range and whitespace intent for the user to understand the runner-child operation.",
	},
	{
		id: "self-hosted-edit-single-approval",
		label: "Self-hosted single Edit approval",
		evidenceRequired:
			"Each claimed stock client shows the complete single-edit intent and exact diff before approval where required.",
	},
	{
		id: "self-hosted-edit-batch-approval",
		label: "Self-hosted batch Edit approval",
		evidenceRequired:
			"Each claimed stock client shows every edits[] change as a complete exact diff before approval.",
	},
	{
		id: "self-hosted-write-approval",
		label: "Self-hosted Write approval",
		evidenceRequired:
			"Each claimed stock client shows complete create and overwrite intent while the child preserves modified-since-read protection.",
	},
	{
		id: "self-hosted-tool-inventory",
		label: "Self-hosted tool inventory",
		evidenceRequired:
			"The live child tool inventory matches the candidate profile and contains no disabled-tool prompt leaks.",
	},
	{
		id: "self-hosted-prompt-surface",
		label: "Self-hosted prompt surfaces",
		evidenceRequired:
			"Exported and live child prompts contain the intended policy without terminal-only or disabled-tool contradictions.",
	},
	{
		id: "self-hosted-agent-surface",
		label: "Self-hosted agent and skill surfaces",
		evidenceRequired:
			"Agent, subagent, workflow, skill, and progress behavior stays synchronized between the runner child and every claimed client.",
	},
	{
		id: "self-hosted-command-surface",
		label: "Self-hosted command surface",
		evidenceRequired:
			"The runner child and claimed clients expose only the command behavior intended by the candidate profile.",
	},
	{
		id: "self-hosted-protocol-events",
		label: "Self-hosted protocol event projection",
		evidenceRequired:
			"Upstream-owned cloud-session events carry complete semantic state without depending on terminal renderers or custom interception.",
	},
	{
		id: "self-hosted-reconnect-resume",
		label: "Self-hosted reconnect and resume",
		evidenceRequired:
			"Disconnect, runner release, reconnect, and supported resume paths preserve candidate behavior and synchronized client state.",
	},
	{
		id: "self-hosted-runner-upgrade",
		label: "Self-hosted runner upgrade policy",
		evidenceRequired:
			"A pinned image replacement follows explicit rebuild, drain, promotion, and rollback policy without silent profile drift.",
	},
	{
		id: "self-hosted-patch-receipt",
		label: "Self-hosted patched child receipt",
		evidenceRequired:
			"The runner and its exact child binary report the expected ordered self-hosted profile roster separately from the upstream version.",
	},
];

function assertUnique(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value))
			throw new Error(`${label} contains duplicate ${value}`);
		seen.add(value);
	}
}

function validateSurfaceSupport(options: {
	capability: PatchCapability;
	surface: RuntimeSurface;
	support: PatchSurfaceSupport;
	catalogTags: ReadonlySet<string>;
}): void {
	const { capability, surface, support, catalogTags } = options;
	if (!PATCH_SUPPORT_LEVELS.includes(support.level)) {
		throw new Error(
			`Patch ${capability.tag} has invalid ${surface} support level ${String(support.level)}`,
		);
	}
	const probes = support.requiredProbes ?? [];
	assertUnique(probes, `Patch ${capability.tag} ${surface} probes`);
	for (const probe of probes) {
		if (!PATCH_PROBE_IDS.includes(probe)) {
			throw new Error(`Patch ${capability.tag} has unknown probe ${probe}`);
		}
	}
	const conflicts = support.conflictsWith ?? [];
	assertUnique(conflicts, `Patch ${capability.tag} ${surface} conflicts`);
	for (const conflict of conflicts) {
		if (conflict === capability.tag || !catalogTags.has(conflict)) {
			throw new Error(
				`Patch ${capability.tag} has invalid ${surface} conflict ${conflict}`,
			);
		}
	}

	if (support.level === "supported") {
		if (support.exclusionReason || probes.length > 0 || conflicts.length > 0) {
			throw new Error(
				`Supported patch ${capability.tag} cannot carry exclusions, probes, or surface conflicts`,
			);
		}
		return;
	}
	if (support.level === "probe-required") {
		if (probes.length === 0) {
			throw new Error(
				`Probe-required patch ${capability.tag} requires at least one probe`,
			);
		}
		if (support.exclusionReason) {
			throw new Error(
				`Probe-required patch ${capability.tag} cannot have an exclusion reason`,
			);
		}
		return;
	}
	if (!support.exclusionReason) {
		throw new Error(
			`Excluded patch ${capability.tag} requires an exclusion reason`,
		);
	}
	if (probes.length > 0) {
		throw new Error(`Excluded patch ${capability.tag} cannot require probes`);
	}
	if (
		support.exclusionReason === "conflicting-tool-policy" &&
		conflicts.length === 0
	) {
		throw new Error(
			`Conflicting tool-policy patch ${capability.tag} requires conflictsWith`,
		);
	}
}

export function validatePatchCapabilityCatalog(
	catalog: readonly Patch[],
	capabilities: readonly PatchCapability[],
): void {
	const catalogTags = catalog.map(({ tag }) => tag);
	const capabilityTags = capabilities.map(({ tag }) => tag);
	assertUnique(catalogTags, "Patch catalog");
	assertUnique(capabilityTags, "Capability catalog");
	const catalogTagSet = new Set(catalogTags);
	const capabilityTagSet = new Set(capabilityTags);
	for (const tag of catalogTags) {
		if (!capabilityTagSet.has(tag)) {
			throw new Error(`Missing capability record for patch ${tag}`);
		}
	}
	for (const tag of capabilityTags) {
		if (!catalogTagSet.has(tag)) {
			throw new Error(`Unknown capability record for patch ${tag}`);
		}
	}
	if (catalogTags.some((tag, index) => capabilityTags[index] !== tag)) {
		throw new Error(
			"Capability catalog does not preserve patch registration order",
		);
	}

	for (const capability of capabilities) {
		if (capability.effects.length === 0) {
			throw new Error(`Patch ${capability.tag} has no classified effects`);
		}
		assertUnique(capability.effects, `Patch ${capability.tag} effects`);
		for (const effect of capability.effects) {
			if (!PATCH_EFFECTS.includes(effect)) {
				throw new Error(`Patch ${capability.tag} has invalid effect ${effect}`);
			}
		}
		for (const key of Object.keys(capability.support)) {
			if (!CAPABILITY_SURFACES.includes(key as RuntimeSurface)) {
				throw new Error(`Patch ${capability.tag} has unknown surface ${key}`);
			}
		}
		if (capability.support.cli?.level !== "supported") {
			throw new Error(
				`Patch ${capability.tag} must remain supported by cli-full`,
			);
		}
		if (!capability.support["desktop-local"]) {
			throw new Error(
				`Patch ${capability.tag} has no desktop-local classification`,
			);
		}
		if (!capability.support["remote-control"]) {
			throw new Error(
				`Patch ${capability.tag} has no remote-control classification`,
			);
		}
		if (!capability.support["self-hosted-runner"]) {
			throw new Error(
				`Patch ${capability.tag} has no self-hosted-runner classification`,
			);
		}
		for (const [surface, support] of Object.entries(capability.support)) {
			if (!support) continue;
			validateSurfaceSupport({
				capability,
				surface: surface as RuntimeSurface,
				support,
				catalogTags: catalogTagSet,
			});
		}
	}

	for (const patch of catalog) {
		for (const relatedTag of [
			...(patch.requires ?? []),
			...(patch.conflicts ?? []),
		]) {
			if (!catalogTagSet.has(relatedTag)) {
				throw new Error(
					`Patch ${patch.tag} references unknown patch ${relatedTag}`,
				);
			}
		}
	}
}

function capabilitiesFor(catalog: readonly Patch[]): PatchCapability[] {
	return catalog.map((patch) => {
		const definition = CAPABILITY_DEFINITIONS[patch.tag];
		if (!definition) {
			throw new Error(`Missing capability definition for patch ${patch.tag}`);
		}
		return { tag: patch.tag, ...definition };
	});
}

export const patchCapabilities: readonly PatchCapability[] =
	capabilitiesFor(registeredPatches);

export const profilePatchCapabilities: readonly PatchCapability[] =
	capabilitiesFor(profilePatchCatalog);

validatePatchCapabilityCatalog(registeredPatches, patchCapabilities);
validatePatchCapabilityCatalog(profilePatchCatalog, profilePatchCapabilities);

if (patchProbeDefinitions.length !== PATCH_PROBE_IDS.length) {
	throw new Error("Patch probe definition catalog is incomplete");
}
assertUnique(
	patchProbeDefinitions.map(({ id }) => id),
	"Patch probe definitions",
);
