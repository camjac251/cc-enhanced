import type { DesktopPermissionPreflightEvidence } from "../desktop/permission-preflight.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopPermissionPreflight(
	result: OperationResult<DesktopPermissionPreflightEvidence>,
): string[] {
	const evidence = result.data;
	const gate = (id: string) =>
		evidence.gates.find((candidate) => candidate.id === id);
	return [
		"",
		"Claude Desktop Read/Edit/Write Stock Preflight",
		"",
		`  Status:                    ${evidence.readyForStockBaseline ? "ready" : "not ready"}`,
		`  Desktop:                   ${evidence.target.desktopVersion} (${evidence.target.platform})`,
		`  Stock Code target:          ${evidence.target.codeVersion} (${evidence.target.nativePlatform})`,
		`  Inventory selection:        ${evidence.target.inventorySelectionReason}`,
		`  Official stock identity:    ${gate("official-stock-identity")?.status}`,
		`  Platform signature present: ${gate("platform-signature-presence")?.status}`,
		`  Profile safety boundary:     ${gate("desktop-profile-boundary")?.status}`,
		"",
		"  Blockers:",
		...evidence.blockers.map(
			(blocker) => `    - ${blocker.responsibility}: ${blocker.requirement}`,
		),
		"",
		"  No Desktop launch or managed-artifact mutation was authorized or run.",
		"",
	];
}
