import type {
	DesktopDriftChange,
	DesktopInventoryDrift,
} from "../desktop/drift.js";
import type { OperationResult } from "../operations/contract.js";

function cacheVersion(change: DesktopDriftChange): string {
	return change.locatorId?.replace(/^desktop-code:/, "") ?? "unknown";
}

function renderChange(change: DesktopDriftChange): string {
	switch (change.kind) {
		case "desktop-added":
			return `Desktop package added: ${change.after}`;
		case "desktop-removed":
			return `Desktop package removed: ${change.before}`;
		case "desktop-version-changed":
			return `Desktop version changed: ${change.before} -> ${change.after}`;
		case "desktop-layout-changed":
			return `Desktop layout changed: ${change.before} -> ${change.after}`;
		case "desktop-agent-sdk-changed":
			return `Agent SDK changed: ${change.before} -> ${change.after}`;
		case "desktop-code-pin-changed":
			return `Declared Code pin changed: ${change.before} -> ${change.after}`;
		case "desktop-package-content-changed":
			return `Desktop package member count changed: ${change.before} -> ${change.after}`;
		case "cache-row-removed":
			return `Cache row removed: ${cacheVersion(change)}`;
		case "cache-artifact-replaced":
			return `Cache artifact replaced: ${cacheVersion(change)}`;
		case "cache-row-added":
			return `Cache row added: ${cacheVersion(change)}`;
		case "selected-code-changed":
			return `Selected Code row changed: ${change.before} -> ${change.after}`;
		case "selection-reason-changed":
			return `Selection reason changed: ${change.before} -> ${change.after}`;
	}
}

export function renderDesktopDrift(
	result: OperationResult<DesktopInventoryDrift>,
): string[] {
	const lines = [
		"",
		"Claude Desktop Drift",
		"",
		`  Platform: ${result.data.platform}`,
		`  Status:   ${result.data.status}`,
	];
	if (result.data.changes.length === 0) {
		lines.push("  Changes:  none");
	} else {
		lines.push(`  Changes:  ${result.data.changes.length}`);
		for (const change of result.data.changes) {
			lines.push(`    - ${renderChange(change)}`);
		}
	}
	lines.push("");
	return lines;
}
