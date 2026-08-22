import type { PatchProfile } from "./contract.js";
import {
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	STOCK_CLIENT_POLICY_EXCLUSIONS,
} from "./stock-client.js";

export const DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS =
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS;

export const DESKTOP_LOCAL_CANDIDATE_TAGS =
	DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS.filter(
		(
			tag,
		): tag is Exclude<
			(typeof DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS)[number],
			"effort-stack"
		> => tag !== "effort-stack",
	);

export const DESKTOP_LOCAL_POLICY_EXCLUSIONS = STOCK_CLIENT_POLICY_EXCLUSIONS;

export const DESKTOP_LOCAL_TARGET_EXCLUSIONS = [
	{ tag: "effort-stack", reason: "unsupported-runtime" },
] as const;

export const DESKTOP_LOCAL_EXCLUSIONS = [
	...DESKTOP_LOCAL_POLICY_EXCLUSIONS,
	...DESKTOP_LOCAL_TARGET_EXCLUSIONS,
] as const;

export const DESKTOP_LOCAL_REQUIRED_PROBES = [
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

export const desktopLocalCandidateProfile = {
	name: "desktop-local",
	surface: "desktop-local",
	includes: DESKTOP_LOCAL_CANDIDATE_TAGS,
	excludes: DESKTOP_LOCAL_EXCLUSIONS,
	requiredProbes: DESKTOP_LOCAL_REQUIRED_PROBES,
} as const satisfies PatchProfile;
