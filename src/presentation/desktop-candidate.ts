import type { DesktopCandidateBuildOutput } from "../desktop/candidate.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopCandidateBuild(
	result: OperationResult<DesktopCandidateBuildOutput>,
): string[] {
	const output = result.data;
	const { candidate, profile, target } = output.evidence;
	return [
		"",
		"Claude Desktop Offline Patched Candidate",
		"",
		"  Status:                  constructed and verified",
		`  Desktop baseline:        ${target.desktopVersion} (${target.platform})`,
		`  Stock Code source:       ${target.codeVersion} (${target.nativePlatform})`,
		`  Profile:                 ${profile.name} (${profile.supportReadiness})`,
		`  Selected patches:        ${profile.selectedTags.length}`,
		`  Excluded patches:        ${profile.exclusions.length}`,
		`  Required live probes:    ${profile.requiredProbes.length}`,
		`  Candidate path:          ${output.candidatePath}`,
		`  Clean source SHA-256:    ${candidate.cleanSha256}`,
		`  Patched candidate SHA-256: ${candidate.patchedSha256}`,
		`  Fixed-layout size:       ${candidate.size} bytes`,
		`  Patch verification:      ${candidate.patchVerification}`,
		`  Structural verification: ${candidate.structuralVerification}`,
		`  Signing:                 ${candidate.signingVerification}`,
		`  Host execution:          ${candidate.hostExecution}`,
		`  Desktop launch:          ${candidate.desktopLaunch}`,
		`  Profile promotion:       ${output.evidence.boundaries.profilePromotion}`,
		"",
		"  This is a separate repository-local candidate copy.",
		"  Managed-artifact mutation, signing, activation, Desktop launch, profile promotion, remote control, and self-hosted execution were not authorized or run.",
		"",
	];
}
