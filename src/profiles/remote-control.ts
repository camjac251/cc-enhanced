import type { PatchProfile } from "./contract.js";
import {
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	STOCK_CLIENT_POLICY_EXCLUSIONS,
} from "./stock-client.js";

export const REMOTE_CONTROL_CANDIDATE_TAGS = STOCK_CLIENT_POLICY_CANDIDATE_TAGS;

export const REMOTE_CONTROL_EXCLUSIONS = STOCK_CLIENT_POLICY_EXCLUSIONS;

export const REMOTE_CONTROL_REQUIRED_PROBES = [
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

export const remoteControlCandidateProfile = {
	name: "remote-control",
	surface: "remote-control",
	includes: REMOTE_CONTROL_CANDIDATE_TAGS,
	excludes: REMOTE_CONTROL_EXCLUSIONS,
	requiredProbes: REMOTE_CONTROL_REQUIRED_PROBES,
} as const satisfies PatchProfile;
