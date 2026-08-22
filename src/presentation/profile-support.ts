import type { OperationResult } from "../operations/contract.js";
import type { PatchSurfaceReadiness } from "../profiles/readiness.js";

const TITLE_BY_PROFILE: Record<PatchSurfaceReadiness["profile"], string> = {
	"cli-full": "CLI Full Patch Support",
	"desktop-local": "Desktop Local Patch Support",
	"desktop-wsl": "Desktop WSL Patch Support",
	"desktop-ssh": "Desktop SSH Patch Support",
	"remote-control": "Remote Control Patch Support",
	"self-hosted-runner": "Self-hosted Runner Patch Support",
	"desktop-ui-experimental": "Desktop UI Experimental Patch Support",
};

function patchCount(count: number): string {
	return `${count} ${count === 1 ? "patch" : "patches"}`;
}

export function renderProfileSupport(
	result: OperationResult<PatchSurfaceReadiness>,
): string[] {
	const report = result.data;
	const lines = [
		"",
		TITLE_BY_PROFILE[report.profile],
		"",
		`  Surface:   ${report.surface}`,
		`  Profile:   ${report.profile}`,
		`  Readiness: ${report.readiness}`,
		`  Summary:   ${report.summary.supported} supported; ${report.summary.probeRequired} probe-required; ${report.summary.excluded} excluded; ${report.summary.notAssessed} not-assessed`,
	];

	if (report.selectable) {
		lines.push("  Selection: ready and selectable");
	} else {
		lines.push(
			"  Selection: reserved and not selectable; no target patching is authorized",
		);
	}

	if (report.requiredProbes.length > 0) {
		lines.push("", "  Required probes:");
		for (const probe of report.requiredProbes) {
			lines.push(
				`    ${probe.id}: ${probe.status} (${patchCount(probe.tags.length)})`,
				`      ${probe.evidenceRequired}`,
			);
		}
	}

	const exclusions = report.patches.filter(
		({ support }) => support === "excluded",
	);
	if (exclusions.length > 0) {
		lines.push("", "  Exclusions:");
		for (const patch of exclusions) {
			const conflicts =
				patch.conflictsWith.length > 0
					? `; conflicts with ${patch.conflictsWith.join(", ")}`
					: "";
			lines.push(
				`    ${patch.tag}: ${patch.exclusionReason ?? "unclassified"}${conflicts}`,
			);
		}
	}

	if (report.summary.notAssessed > 0) {
		lines.push(
			"",
			"  This surface has no support assessment. No compatibility claim is made.",
		);
	}
	lines.push("");
	return lines;
}
