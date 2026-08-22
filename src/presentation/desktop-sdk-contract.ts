import type { DesktopSdkContractEvidence } from "../desktop/sdk-contract.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopSdkContract(
	result: OperationResult<DesktopSdkContractEvidence>,
): string[] {
	const evidence = result.data;
	return [
		"",
		"Claude Desktop SDK Public Contract",
		"",
		"  Desktop version:       " +
			evidence.inventoryBinding.desktopVersion +
			" (" +
			evidence.inventoryBinding.platform +
			")",
		"  Packaged SDK version:   " +
			evidence.inventoryBinding.packagedAgentSdkVersion,
		`  Registry package:       ${evidence.registry.packageName}`,
		"  Tarball integrity:      " +
			evidence.registry.integrityAlgorithm +
			" verified",
		"  Registry signatures:    " +
			evidence.registry.signaturePresence +
			" (" +
			evidence.registry.signatureCount +
			")",
		"  Declaration members:    " +
			evidence.registry.declarationMembers +
			" / " +
			evidence.registry.declarationBytes +
			" bytes",
		"  Permission callback:    " +
			evidence.permissionContract.callback.typeName,
		"  Allow updatedInput:     optional record",
		"  Deny message:           required string",
		"  Permission modes:       " +
			evidence.permissionContract.mode.values.join(", "),
		`  Bundled identity:       ${evidence.boundaries.bundledRuntimeIdentity}`,
		`  Callback execution:     ${evidence.boundaries.liveCallbackExecution}`,
		`  UI projection:          ${evidence.boundaries.uiProjection}`,
		"",
	];
}
