import {
	createOperationResult,
	type OperationResult,
} from "../operations/contract.js";
import {
	type DesktopArtifactInspectionEvidence,
	validateDesktopArtifactInspectionEvidence,
} from "./artifact-inspection.js";
import {
	type DesktopCandidateBuildOutput,
	validateDesktopCandidateEvidence,
} from "./candidate.js";
import type { DesktopInventoryReport } from "./contract.js";
import type { DesktopInventoryDrift } from "./drift.js";
import {
	type DesktopPermissionPreflightEvidence,
	validateDesktopPermissionPreflightEvidence,
} from "./permission-preflight.js";
import {
	type DesktopPermissionProbePlanEvidence,
	validateDesktopPermissionProbePlanEvidence,
} from "./permission-probe.js";
import {
	type DesktopSdkContractEvidence,
	validateDesktopSdkContractEvidence,
} from "./sdk-contract.js";

export function createDesktopStatusResult(
	report: DesktopInventoryReport,
): OperationResult<DesktopInventoryReport> {
	const application = report.applications.find(
		(candidate) => candidate.locatorId === report.selectedApplicationLocatorId,
	);
	const selectedCode = report.cachedCode.find(
		(candidate) => candidate.locatorId === report.selectedCodeLocatorId,
	);
	const warnings = [];
	if (application?.declaredCodePin.status !== "resolved") {
		warnings.push({
			code: "desktop-code-pin-unresolved",
			message: "The Desktop package did not expose a stable semantic Code pin.",
		});
	} else if (report.selectedCodeReason !== "declared-pin") {
		warnings.push({
			code: "desktop-code-pin-cache-miss",
			message:
				"The declared Desktop Code pin is absent from the inspected cache.",
		});
	}
	if (selectedCode?.signatureInspection === "not-inspected") {
		warnings.push({
			code: "desktop-code-signature-not-inspected",
			message:
				"Platform signature inspection was not run for the selected cache row.",
		});
	}
	if (selectedCode?.patchReceiptInspection === "not-inspected") {
		warnings.push({
			code: "desktop-code-patch-receipt-not-inspected",
			message:
				"Deep patch-receipt inspection was not run for the selected cache row.",
		});
	}
	return createOperationResult({
		operation: "desktop-status",
		ok: Boolean(application && selectedCode),
		target:
			selectedCode?.platform && selectedCode
				? {
						id: `desktop-local:${selectedCode.platform}:${selectedCode.version}`,
						kind: "desktop-local",
						surface: "desktop-local",
						platform: selectedCode.platform,
						versionLane: "desktop-current",
					}
				: null,
		checks: [
			{
				id: "desktop-application",
				status: application ? "pass" : "fail",
			},
			{
				id: "desktop-code-cache",
				status: selectedCode ? "pass" : "fail",
			},
			{
				id: "desktop-code-pin",
				status:
					application?.declaredCodePin.status === "resolved"
						? report.selectedCodeReason === "declared-pin"
							? "pass"
							: "fail"
						: "skipped",
			},
		],
		warnings,
		data: report,
	});
}

export function createDesktopDriftResult(
	drift: DesktopInventoryDrift,
): OperationResult<DesktopInventoryDrift> {
	const changed = drift.status === "changed";
	return createOperationResult({
		operation: "desktop-compare",
		ok: !changed,
		target: null,
		checks: [
			{
				id: "desktop-update-drift",
				status: changed ? "fail" : "pass",
				detail: changed
					? `${drift.changes.length} lifecycle change(s) detected`
					: "No lifecycle changes detected",
			},
		],
		warnings: changed
			? [
					{
						code: "desktop-update-drift-detected",
						message:
							"Desktop package or managed Code state differs from the baseline.",
					},
				]
			: [],
		data: drift,
	});
}

export function createDesktopArtifactInspectionResult(
	evidence: DesktopArtifactInspectionEvidence,
): OperationResult<DesktopArtifactInspectionEvidence> {
	validateDesktopArtifactInspectionEvidence(evidence);
	const warnings = [];
	if (evidence.selectionReason === "highest-cached") {
		warnings.push({
			code: "desktop-highest-cache-not-pin",
			message:
				"The inspected cache row is the highest observed version, not a declared Desktop pin.",
		});
	}
	if (evidence.provenance.status === "not-run") {
		warnings.push({
			code: "desktop-provenance-not-run",
			message: "Exact official release-manifest provenance was not checked.",
		});
	}
	warnings.push({
		code: "desktop-signature-validity-not-run",
		message:
			"Platform-signature presence was inspected, but cryptographic validity and host trust policy were not checked.",
	});
	if (evidence.patchReceipt.status === "not-run") {
		warnings.push({
			code: "desktop-patch-receipt-not-run",
			message: "Deep embedded patch-receipt inspection was not run.",
		});
	} else if (evidence.patchReceipt.status === "absent") {
		warnings.push({
			code: "desktop-patch-marker-absent-limited",
			message:
				"The cc-enhanced marker is absent; this alone does not prove that no other modification exists.",
		});
	}
	warnings.push(
		{
			code: "desktop-version-execution-not-run",
			message: "The inspected Desktop Code artifact was not executed.",
		},
		{
			code: "desktop-surface-compatibility-not-evaluated",
			message:
				"Desktop permission, approval, diff, and presentation compatibility were not evaluated.",
		},
		{
			code: "desktop-activation-not-authorized",
			message:
				"This inspection does not authorize patch construction, staging, signing, activation, or rollback.",
		},
	);
	const provenanceFailed = evidence.provenance.status === "mismatch";
	return createOperationResult({
		operation: "desktop-inspect",
		ok: !provenanceFailed,
		target: {
			id: `desktop-local:${evidence.nativePlatform}:${evidence.version}`,
			kind: "desktop-local",
			surface: "desktop-local",
			platform: evidence.nativePlatform,
			versionLane: "desktop-current",
		},
		checks: [
			{ id: "artifact-binding", status: "pass" },
			{
				id: "official-provenance",
				status:
					evidence.provenance.status === "not-run"
						? "skipped"
						: provenanceFailed
							? "fail"
							: "pass",
			},
			{ id: "signature-presence", status: "pass" },
			{ id: "signature-validity", status: "skipped" },
			{
				id: "patch-receipt",
				status: evidence.patchReceipt.status === "not-run" ? "skipped" : "pass",
			},
			{ id: "version-execution", status: "skipped" },
			{ id: "surface-compatibility", status: "skipped" },
			{ id: "activation-authorization", status: "skipped" },
		],
		warnings,
		data: evidence,
	});
}

export function createDesktopSdkContractResult(
	evidence: DesktopSdkContractEvidence,
): OperationResult<DesktopSdkContractEvidence> {
	validateDesktopSdkContractEvidence(evidence);
	const registrySignatureWarning =
		evidence.registry.signaturePresence === "present-unverified"
			? {
					code: "desktop-sdk-registry-signature-validity-not-run",
					message:
						"The registry supplied package signatures, but their cryptographic validity was not checked.",
				}
			: {
					code: "desktop-sdk-registry-signature-not-provided",
					message:
						"The registry metadata did not provide a package signature to validate.",
				};
	return createOperationResult({
		operation: "desktop-sdk-contract",
		ok: true,
		target: null,
		checks: [
			{ id: "inventory-binding", status: "pass" },
			{ id: "registry-origin", status: "pass" },
			{ id: "tarball-integrity", status: "pass" },
			{ id: "public-declaration-contract", status: "pass" },
			{ id: "registry-signature-validity", status: "skipped" },
			{ id: "bundled-runtime-identity", status: "skipped" },
			{ id: "live-callback-execution", status: "skipped" },
			{ id: "ui-projection", status: "skipped" },
		],
		warnings: [
			registrySignatureWarning,
			{
				code: "desktop-sdk-bundled-runtime-identity-not-proven",
				message:
					"The public package contract does not prove byte identity with the implementation bundled into Desktop.",
			},
			{
				code: "desktop-sdk-live-callback-not-run",
				message:
					"No packaged Desktop permission callback was invoked in a live session.",
			},
			{
				code: "desktop-sdk-ui-projection-not-run",
				message:
					"Desktop approval, diff, card, and arbitrary-field projection were not observed.",
			},
		],
		data: evidence,
	});
}

export function createDesktopPermissionProbePlanResult(
	evidence: DesktopPermissionProbePlanEvidence,
): OperationResult<DesktopPermissionProbePlanEvidence> {
	validateDesktopPermissionProbePlanEvidence(evidence);
	return createOperationResult({
		operation: "desktop-permission-probe-plan",
		ok: true,
		target: null,
		checks: [
			{ id: "sdk-contract-binding", status: "pass" },
			{ id: "facet-coverage", status: "pass" },
			{ id: "scenario-coverage", status: "pass" },
			{ id: "target-selection", status: "skipped" },
			{ id: "explicit-consent", status: "skipped" },
			{ id: "live-execution", status: "skipped" },
			{ id: "profile-readiness", status: "skipped" },
		],
		warnings: [
			{
				code: "desktop-probe-target-selection-required",
				message:
					"An exact Desktop Code target must be selected and rebound before this protocol can run.",
			},
			{
				code: "desktop-probe-consent-required",
				message:
					"Live Desktop execution and any isolated candidate mutation require explicit consent.",
			},
			{
				code: "desktop-probe-execution-not-run",
				message:
					"No Desktop process, callback, tool, approval, diff, card, restart, or resume probe was run.",
			},
			{
				code: "desktop-probe-profile-still-blocked",
				message:
					"This plan does not change capability evidence or make a Desktop profile selectable.",
			},
		],
		data: evidence,
	});
}

export function createDesktopPermissionPreflightResult(
	evidence: DesktopPermissionPreflightEvidence,
): OperationResult<DesktopPermissionPreflightEvidence> {
	validateDesktopPermissionPreflightEvidence(evidence);
	return createOperationResult({
		operation: "desktop-permission-preflight",
		ok: evidence.readyForStockBaseline,
		target: {
			id: `desktop-local:${evidence.target.nativePlatform}:${evidence.target.codeVersion}`,
			kind: "desktop-local",
			surface: "desktop-local",
			platform: evidence.target.nativePlatform,
			versionLane: "desktop-current",
		},
		checks: evidence.gates.map((gate) => ({
			id: gate.id,
			status: gate.status === "pass" ? "pass" : "fail",
			detail: gate.detail,
		})),
		warnings: evidence.blockers.map((blocker) => ({
			code: blocker.code,
			message: blocker.requirement,
		})),
		data: evidence,
	});
}

export function createDesktopCandidateBuildResult(
	output: DesktopCandidateBuildOutput,
): OperationResult<DesktopCandidateBuildOutput> {
	validateDesktopCandidateEvidence(output.evidence);
	const { candidate, target } = output.evidence;
	return createOperationResult({
		operation: "desktop-candidate-build",
		ok: true,
		target: {
			id: `desktop-local:${target.nativePlatform}:${target.codeVersion}`,
			kind: "desktop-local",
			surface: "desktop-local",
			platform: target.nativePlatform,
			versionLane: "desktop-current",
		},
		profile: output.profile,
		artifact: output.artifactReceipt,
		checks: [
			{ id: "stock-evidence-chain", status: "pass" },
			{ id: "exact-source-identity", status: "pass" },
			{
				id: "candidate-profile",
				status: "pass",
				detail: `${output.profile.selectedTags.length} selected, ${output.profile.exclusions.length} excluded, ${output.profile.requiredProbes.length} required probes`,
			},
			{ id: "separate-candidate-copy", status: "pass" },
			{ id: "patch-verification", status: candidate.patchVerification },
			{
				id: "structural-verification",
				status: candidate.structuralVerification,
			},
			{ id: "signing", status: "skipped" },
			{ id: "host-execution", status: "skipped" },
			{ id: "desktop-launch", status: "skipped" },
			{ id: "profile-promotion", status: "skipped" },
			{ id: "remote-control", status: "skipped" },
			{ id: "self-hosted-execution", status: "skipped" },
		],
		warnings: [
			{
				code: "desktop-candidate-unsigned",
				message:
					"The separate candidate was not signed and has not passed matching-host trust policy.",
			},
			{
				code: "desktop-candidate-not-executed",
				message:
					"The candidate was not executed directly or launched through Desktop.",
			},
			{
				code: "desktop-managed-artifact-not-authorized",
				message:
					"Managed-artifact mutation, activation, and profile promotion remain unauthorized.",
			},
			{
				code: "desktop-profile-still-blocked",
				message:
					"The desktop-local profile remains non-selectable until every required live probe passes.",
			},
			{
				code: "desktop-remote-surfaces-closed",
				message:
					"Remote control and self-hosted execution were not started and remain outside this operation.",
			},
		],
		data: output,
	});
}
