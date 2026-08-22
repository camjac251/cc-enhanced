import type { DesktopInventoryReport } from "../desktop/contract.js";
import type { OperationResult } from "../operations/contract.js";

export function renderDesktopStatus(
	result: OperationResult<DesktopInventoryReport>,
): string[] {
	const report = result.data;
	const application = report.applications.find(
		(candidate) => candidate.locatorId === report.selectedApplicationLocatorId,
	);
	const lines = [
		"",
		"Claude Desktop Status",
		"",
		`  Platform: ${report.platform}`,
	];
	if (application) {
		lines.push(
			`  Desktop:  ${application.version} (${application.layout})`,
			`  Agent SDK: ${application.packagedAgentSdk.version ?? "unresolved"}`,
			`  Code pin:  ${application.declaredCodePin.version ?? "unresolved"}`,
			`  App root:  ${application.rootPath}`,
		);
	} else {
		lines.push("  Desktop:  not found");
	}
	lines.push("", "  Managed Code cache:");
	if (report.cachedCode.length === 0) {
		lines.push("    (none)");
	} else {
		for (const artifact of report.cachedCode) {
			lines.push(
				`    ${artifact.version} ${artifact.platform ?? "unknown-platform"} ${artifact.binaryFormat} ${artifact.architecture}`,
				`      Binary: ${artifact.binaryPath}`,
				`      Signing: ${artifact.signatureInspection}; patch receipt: ${artifact.patchReceiptInspection}`,
			);
		}
	}
	const selected = report.cachedCode.find(
		(artifact) => artifact.locatorId === report.selectedCodeLocatorId,
	);
	if (selected) {
		lines.push(
			report.selectedCodeReason === "declared-pin"
				? `  Selected: ${selected.version} (declared pin)`
				: `  Selected: ${selected.version} (highest cached; not a declared pin)`,
		);
	} else {
		lines.push("  Selected: (none)");
	}
	lines.push("");
	return lines;
}
