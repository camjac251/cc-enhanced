import type { OperationResult } from "../operations/contract.js";
import type { RemoteControlReadinessPlan } from "../remote-control/readiness.js";

export function renderRemoteControlReadiness(
	result: OperationResult<RemoteControlReadinessPlan>,
): string[] {
	const evidence = result.data;
	const lines = [
		"",
		"Remote Control Probe Readiness",
		"",
		`  Probe launch:    ${evidence.readyForProbeLaunch ? "ready" : "blocked"}`,
		`  Profile support: ${evidence.profile.readiness} and non-selectable (${evidence.profile.summary.supported} supported; ${evidence.profile.summary.probeRequired} probe-required; ${evidence.profile.summary.excluded} excluded)`,
		"  Live execution:  not run; start is a separate explicit action",
		"  Transcript storage: acknowledgement required at start",
		"  Transport: upstream-owned process with inherited stdio",
		"",
		"  Client evidence:",
		`    Web:     ${evidence.clients.web}`,
		`    Mobile:  ${evidence.clients.mobile}`,
		`    Desktop: ${evidence.clients.desktop}; arbitrary standalone-session steering is probe-required`,
		"",
		"  Read/Edit: range presentation and batch Edit approval remain probe-required",
	];
	if (evidence.blockers.length > 0) {
		lines.push("", "  Probe-launch blockers:");
		for (const blocker of evidence.blockers) lines.push(`    ${blocker}`);
	}
	lines.push("");
	return lines;
}
