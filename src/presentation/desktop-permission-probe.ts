import type { DesktopPermissionProbePlanEvidence } from "../desktop/permission-probe.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopPermissionProbePlan(
	result: OperationResult<DesktopPermissionProbePlanEvidence>,
): string[] {
	const plan = result.data;
	return [
		"",
		"Claude Desktop Read/Edit/Write Probe Plan",
		"",
		`  Desktop version:         ${plan.sdkContractBinding.desktopVersion} (${plan.sdkContractBinding.platform})`,
		`  Packaged SDK version:     ${plan.sdkContractBinding.packagedAgentSdkVersion}`,
		`  Capability facets:        ${plan.facets.length}`,
		`  Probe scenarios:          ${plan.scenarios.length}`,
		"  Permission modes:         every offered mode (live observation required)",
		`  Protocol lanes:           ${plan.protocol.lanes.join(", ")}`,
		`  Target selection:         ${plan.boundaries.targetSelection}`,
		`  Consent:                  ${plan.boundaries.consent}`,
		`  Mutation authorization:   ${plan.boundaries.mutationAuthorization}`,
		`  Execution:                ${plan.boundaries.execution}`,
		`  Profile selection:        ${plan.boundaries.profileSelection}`,
		`  Bundled SDK identity:      ${plan.boundaries.bundledRuntimeIdentity}`,
		`  UI projection:            ${plan.boundaries.uiProjection}`,
		"",
	];
}
