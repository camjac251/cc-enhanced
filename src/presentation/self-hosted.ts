import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedReadinessPlan } from "../self-hosted/readiness.js";

export function renderSelfHostedReadiness(
	result: OperationResult<SelfHostedReadinessPlan>,
): string[] {
	const evidence = result.data;
	return [
		"",
		"Self-hosted Runner Readiness",
		"",
		`  Candidate construction: ${evidence.readyForCandidateConstruction ? "ready" : "blocked"}`,
		`  Image build:            ${evidence.readyForImageBuild ? "ready" : "blocked"}`,
		`  Deployment:             ${evidence.readyForDeployment ? "ready" : "blocked"}`,
		`  Profile support:        ${evidence.profile.readiness} and non-selectable (${evidence.profile.summary.supported} supported; ${evidence.profile.summary.probeRequired} probe-required; ${evidence.profile.summary.excluded} excluded)`,
		"  Host policy:            Linux and macOS native runners; Windows requires a Linux container",
		`  Version lane:           ${evidence.hostPolicy.versionLane}; exact image version is not yet bound`,
		`  Image receipt:          ${evidence.image.status}`,
		`  Wrapper receipt:        ${evidence.wrapper.status}`,
		"  Wrapper control:        stdin and file descriptor 3 preservation not run",
		"  Runner registration:    not-run",
		"  Runner-child binding:   not-run",
		`  Registry push:          ${evidence.image.registryPush}`,
		"",
		"  Client evidence:",
		`    Web:     ${evidence.clients.web}`,
		`    Mobile:  ${evidence.clients.mobile}`,
		`    Desktop: ${evidence.clients.desktop}`,
		`    CLI:     ${evidence.clients.cli}`,
		"",
		"  Read/Edit: range presentation and batch Edit approval remain probe-required",
		"",
	];
}
