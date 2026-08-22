import type { RuntimeSurface } from "../targets/contract.js";

export const PATCH_EFFECTS = [
	"prompt",
	"tool-schema",
	"runtime",
	"protocol",
	"terminal-rendering",
] as const;

export type PatchEffect = (typeof PATCH_EFFECTS)[number];

export const PATCH_SUPPORT_LEVELS = [
	"supported",
	"probe-required",
	"excluded",
] as const;

export type PatchSupportLevel = (typeof PATCH_SUPPORT_LEVELS)[number];

export const DESKTOP_PATCH_PROBE_IDS = [
	"desktop-runtime-startup",
	"desktop-tool-runtime",
	"desktop-packaged-sdk-permission-input",
	"desktop-read-semantics",
	"desktop-read-card",
	"desktop-edit-single-approval",
	"desktop-edit-batch-approval",
	"desktop-write-approval",
	"desktop-tool-inventory",
	"desktop-prompt-surface",
	"desktop-agent-surface",
	"desktop-command-surface",
	"desktop-protocol-events",
	"desktop-restart-resume",
	"desktop-update-replacement",
	"desktop-patch-receipt",
] as const;

export type DesktopPatchProbeId = (typeof DESKTOP_PATCH_PROBE_IDS)[number];

export const REMOTE_CONTROL_PATCH_PROBE_IDS = [
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
	"remote-control-agent-surface",
	"remote-control-command-surface",
	"remote-control-protocol-events",
	"remote-control-reconnect-resume",
	"remote-control-host-upgrade",
	"remote-control-patch-receipt",
] as const;

export type RemoteControlPatchProbeId =
	(typeof REMOTE_CONTROL_PATCH_PROBE_IDS)[number];

export const SELF_HOSTED_RUNNER_PATCH_PROBE_IDS = [
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
	"self-hosted-agent-surface",
	"self-hosted-command-surface",
	"self-hosted-protocol-events",
	"self-hosted-reconnect-resume",
	"self-hosted-runner-upgrade",
	"self-hosted-patch-receipt",
] as const;

export type SelfHostedRunnerPatchProbeId =
	(typeof SELF_HOSTED_RUNNER_PATCH_PROBE_IDS)[number];

export const PATCH_PROBE_IDS = [
	...DESKTOP_PATCH_PROBE_IDS,
	...REMOTE_CONTROL_PATCH_PROBE_IDS,
	...SELF_HOSTED_RUNNER_PATCH_PROBE_IDS,
] as const;

export type PatchProbeId = (typeof PATCH_PROBE_IDS)[number];

export type PatchProfileName =
	| "cli-full"
	| "desktop-local"
	| "desktop-wsl"
	| "desktop-ssh"
	| "remote-control"
	| "self-hosted-runner"
	| "desktop-ui-experimental";

export type PatchExclusionReason =
	| "terminal-only"
	| "provider-routing"
	| "unverified-approval-shape"
	| "unsupported-runtime"
	| "conflicting-tool-policy";

export interface PatchSurfaceSupport {
	level: PatchSupportLevel;
	exclusionReason?: PatchExclusionReason;
	requiredProbes?: readonly PatchProbeId[];
	conflictsWith?: readonly string[];
}

export interface PatchCapability {
	tag: string;
	effects: readonly PatchEffect[];
	support: Partial<Record<RuntimeSurface, PatchSurfaceSupport>>;
}

export interface PatchProbeDefinition {
	id: PatchProbeId;
	label: string;
	evidenceRequired: string;
}

export interface PatchProfileExclusion {
	tag: string;
	reason: PatchExclusionReason;
}

export interface PatchProfile {
	name: PatchProfileName;
	surface: RuntimeSurface;
	includes: readonly string[];
	excludes: readonly PatchProfileExclusion[];
	requiredProbes: readonly string[];
}

export interface PatchProfileReceipt {
	name: PatchProfileName;
	surface: RuntimeSurface;
	selectedTags: string[];
	exclusions: PatchProfileExclusion[];
	requiredProbes: string[];
}
