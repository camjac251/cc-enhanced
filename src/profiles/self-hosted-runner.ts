import type { PatchProfile } from "./contract.js";
import {
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS,
	STOCK_CLIENT_POLICY_EXCLUSIONS,
} from "./stock-client.js";

export const SELF_HOSTED_RUNNER_CANDIDATE_TAGS =
	STOCK_CLIENT_POLICY_CANDIDATE_TAGS;

export const SELF_HOSTED_RUNNER_EXCLUSIONS = STOCK_CLIENT_POLICY_EXCLUSIONS;

export const SELF_HOSTED_RUNNER_REQUIRED_PROBES = [
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
] as const;

export const selfHostedRunnerCandidateProfile = {
	name: "self-hosted-runner",
	surface: "self-hosted-runner",
	includes: SELF_HOSTED_RUNNER_CANDIDATE_TAGS,
	excludes: SELF_HOSTED_RUNNER_EXCLUSIONS,
	requiredProbes: SELF_HOSTED_RUNNER_REQUIRED_PROBES,
} as const satisfies PatchProfile;
