import type { DesktopArtifactInspectionEvidence } from "../desktop/artifact-inspection.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopArtifactInspection(
	result: OperationResult<DesktopArtifactInspectionEvidence>,
): string[] {
	const evidence = result.data;
	const patchReceipt =
		evidence.patchReceipt.status === "present"
			? `present (${evidence.patchReceipt.tags.join(", ")})`
			: evidence.patchReceipt.status;
	return [
		"",
		"Claude Desktop Artifact Inspection",
		"",
		`  Platform:           ${evidence.platform} / ${evidence.nativePlatform}`,
		`  Code version:       ${evidence.version}`,
		`  Selection:          ${evidence.selectionReason}`,
		`  Artifact binding:   ${evidence.artifactBinding}`,
		`  SHA-256:            ${evidence.sha256}`,
		`  Provenance:         ${evidence.provenance.status}`,
		`  Manifest signature: ${evidence.provenance.manifestSignature}`,
		`  Signature presence: ${evidence.platformSignature.presence}`,
		`  Signature validity: ${evidence.platformSignature.validity}`,
		`  Patch receipt:      ${patchReceipt}`,
		`  Version execution:  ${evidence.versionExecution}`,
		`  Surface support:    ${evidence.surfaceCompatibility}`,
		`  Activation:         ${evidence.patchAuthorization}`,
		"",
	];
}
