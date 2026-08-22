import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { PatchProbeId } from "../profiles/contract.js";
import type { DesktopPlatform } from "./contract.js";
import {
	type DesktopSdkContractEvidence,
	validateDesktopSdkContractEvidence,
} from "./sdk-contract.js";

export const DESKTOP_PERMISSION_PROBE_PLAN_SCHEMA_VERSION = 1 as const;

const MAX_EVIDENCE_BYTES = 512 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const DESKTOP_PLATFORMS = new Set<string>(["linux", "darwin", "win32"]);

export const DESKTOP_PERMISSION_PROBE_FACET_IDS = [
	"read-permission-input",
	"read-runtime-semantics",
	"read-desktop-presentation",
	"edit-permission-input",
	"edit-runtime-semantics",
	"edit-desktop-presentation",
	"write-permission-input",
	"write-runtime-semantics",
	"write-desktop-presentation",
	"permission-mode-coverage",
	"restart-resume",
] as const;

export type DesktopPermissionProbeFacetId =
	(typeof DESKTOP_PERMISSION_PROBE_FACET_IDS)[number];

export type DesktopPermissionProbeTool = "Read" | "Edit" | "Write";
export type DesktopPermissionProbeLayer =
	| "permission-input"
	| "runtime-semantics"
	| "desktop-presentation"
	| "permission-mode"
	| "lifecycle";

export type DesktopPermissionProbeEvidenceChannel =
	| "tool-use-event"
	| "permission-callback-observation"
	| "permission-decision"
	| "tool-result"
	| "desktop-card"
	| "desktop-diff"
	| "fixture-state"
	| "target-mode-inventory"
	| "restart-resume-observation";

export type DesktopPermissionProbeAssertion =
	| "input-fields-complete"
	| "permission-callback-input-equals-tool-input-if-invoked"
	| "tool-result-exact"
	| "desktop-card-intent-complete"
	| "fixture-state-exact"
	| "stock-patched-parity"
	| "extension-behavior-exact"
	| "approval-outcome-recorded"
	| "before-after-diff-exact"
	| "all-batch-diffs-complete"
	| "create-overwrite-intent-complete"
	| "modified-since-read-rejected"
	| "every-offered-mode-observed";

export type DesktopPermissionProbeScenarioId =
	| "read-range"
	| "read-show-whitespace"
	| "read-bounded-large-file"
	| "read-stock-media"
	| "edit-single"
	| "edit-batch"
	| "write-create"
	| "write-overwrite"
	| "write-modified-since-read";

export interface DesktopPermissionProbeFacet {
	id: DesktopPermissionProbeFacetId;
	layer: DesktopPermissionProbeLayer;
	tools: DesktopPermissionProbeTool[];
	requiredProbeIds: PatchProbeId[];
	evidenceChannels: DesktopPermissionProbeEvidenceChannel[];
}

export interface DesktopPermissionProbeScenario {
	id: DesktopPermissionProbeScenarioId;
	tool: DesktopPermissionProbeTool;
	fixtureClass: "synthetic-text" | "synthetic-large-text" | "synthetic-media";
	comparison: "stock-parity" | "extension-delta" | "safety-rejection";
	inputFields: string[];
	facets: DesktopPermissionProbeFacetId[];
	evidenceChannels: DesktopPermissionProbeEvidenceChannel[];
	assertions: DesktopPermissionProbeAssertion[];
	modeCoverage: "every-offered-mode";
}

type DeclaredPermissionMode =
	DesktopSdkContractEvidence["permissionContract"]["mode"]["values"][number];

export interface DesktopPermissionProbePlanEvidence {
	schemaVersion: typeof DESKTOP_PERMISSION_PROBE_PLAN_SCHEMA_VERSION;
	sdkContractBinding: {
		sha256: string;
		inventorySha256: string;
		platform: DesktopPlatform;
		desktopVersion: string;
		packagedAgentSdkVersion: string;
	};
	facets: DesktopPermissionProbeFacet[];
	scenarios: DesktopPermissionProbeScenario[];
	permissionModes: {
		declaredSdkModes: DeclaredPermissionMode[];
		availability: "live-observation-required";
		requiredCoverage: "every-offered-mode";
		notOfferedHandling: "record-not-offered";
		callbackNotInvokedHandling: "record-without-satisfying-permission-input";
	};
	protocol: {
		lanes: ["stock-baseline", "patched-candidate"];
		stages: Array<
			| "preflight"
			| "stock-baseline"
			| "patched-candidate"
			| "restart-resume"
			| "cleanup-rollback"
		>;
		preflightRequirements: Array<
			| "exact-target-selected"
			| "explicit-consent-recorded"
			| "artifact-and-profile-bound"
			| "isolated-synthetic-fixtures"
			| "stock-baseline-available"
			| "rollback-ready"
		>;
		completionRequirements: Array<
			| "all-offered-modes-classified"
			| "all-scenarios-observed-in-required-lanes"
			| "structured-and-ui-evidence-correlated"
			| "restart-resume-passed"
			| "durable-evidence-sanitized"
			| "cleanup-and-rollback-recorded"
		>;
	};
	evidencePolicy: {
		fixtures: "isolated-synthetic-only";
		rawCapture: "ephemeral-local-only";
		durableEvidence: "sanitized-assertions-only";
		forbiddenData: Array<
			| "local-paths"
			| "user-identifiers"
			| "process-identifiers"
			| "session-identifiers"
			| "credentials"
			| "environment-values"
			| "source-excerpts"
			| "fixture-contents"
		>;
	};
	boundaries: {
		targetSelection: "required";
		consent: "required";
		mutationAuthorization: "not-authorized";
		execution: "not-run";
		profileSelection: "blocked";
		bundledRuntimeIdentity: "not-proven";
		uiProjection: "not-run";
	};
}

const FACETS: readonly DesktopPermissionProbeFacet[] = [
	{
		id: "read-permission-input",
		layer: "permission-input",
		tools: ["Read"],
		requiredProbeIds: ["desktop-packaged-sdk-permission-input"],
		evidenceChannels: ["tool-use-event", "permission-callback-observation"],
	},
	{
		id: "read-runtime-semantics",
		layer: "runtime-semantics",
		tools: ["Read"],
		requiredProbeIds: ["desktop-read-semantics"],
		evidenceChannels: ["tool-result", "fixture-state"],
	},
	{
		id: "read-desktop-presentation",
		layer: "desktop-presentation",
		tools: ["Read"],
		requiredProbeIds: ["desktop-read-card"],
		evidenceChannels: ["desktop-card"],
	},
	{
		id: "edit-permission-input",
		layer: "permission-input",
		tools: ["Edit"],
		requiredProbeIds: ["desktop-packaged-sdk-permission-input"],
		evidenceChannels: [
			"tool-use-event",
			"permission-callback-observation",
			"permission-decision",
		],
	},
	{
		id: "edit-runtime-semantics",
		layer: "runtime-semantics",
		tools: ["Edit"],
		requiredProbeIds: ["desktop-tool-runtime"],
		evidenceChannels: ["tool-result", "fixture-state"],
	},
	{
		id: "edit-desktop-presentation",
		layer: "desktop-presentation",
		tools: ["Edit"],
		requiredProbeIds: [
			"desktop-edit-single-approval",
			"desktop-edit-batch-approval",
		],
		evidenceChannels: ["desktop-card", "desktop-diff"],
	},
	{
		id: "write-permission-input",
		layer: "permission-input",
		tools: ["Write"],
		requiredProbeIds: ["desktop-packaged-sdk-permission-input"],
		evidenceChannels: [
			"tool-use-event",
			"permission-callback-observation",
			"permission-decision",
		],
	},
	{
		id: "write-runtime-semantics",
		layer: "runtime-semantics",
		tools: ["Write"],
		requiredProbeIds: ["desktop-tool-runtime"],
		evidenceChannels: ["tool-result", "fixture-state"],
	},
	{
		id: "write-desktop-presentation",
		layer: "desktop-presentation",
		tools: ["Write"],
		requiredProbeIds: ["desktop-write-approval"],
		evidenceChannels: ["desktop-card", "desktop-diff"],
	},
	{
		id: "permission-mode-coverage",
		layer: "permission-mode",
		tools: ["Read", "Edit", "Write"],
		requiredProbeIds: [
			"desktop-edit-single-approval",
			"desktop-edit-batch-approval",
			"desktop-write-approval",
		],
		evidenceChannels: [
			"target-mode-inventory",
			"permission-callback-observation",
			"permission-decision",
		],
	},
	{
		id: "restart-resume",
		layer: "lifecycle",
		tools: ["Read", "Edit", "Write"],
		requiredProbeIds: ["desktop-restart-resume"],
		evidenceChannels: ["restart-resume-observation", "fixture-state"],
	},
];

const READ_CHANNELS: DesktopPermissionProbeEvidenceChannel[] = [
	"tool-use-event",
	"permission-callback-observation",
	"tool-result",
	"desktop-card",
	"fixture-state",
];

const MUTATION_CHANNELS: DesktopPermissionProbeEvidenceChannel[] = [
	"tool-use-event",
	"permission-callback-observation",
	"permission-decision",
	"tool-result",
	"desktop-card",
	"desktop-diff",
	"fixture-state",
];

const READ_FACETS: DesktopPermissionProbeFacetId[] = [
	"read-permission-input",
	"read-runtime-semantics",
	"read-desktop-presentation",
	"permission-mode-coverage",
	"restart-resume",
];

const EDIT_FACETS: DesktopPermissionProbeFacetId[] = [
	"edit-permission-input",
	"edit-runtime-semantics",
	"edit-desktop-presentation",
	"permission-mode-coverage",
	"restart-resume",
];

const WRITE_FACETS: DesktopPermissionProbeFacetId[] = [
	"write-permission-input",
	"write-runtime-semantics",
	"write-desktop-presentation",
	"permission-mode-coverage",
	"restart-resume",
];

const BASE_ASSERTIONS: DesktopPermissionProbeAssertion[] = [
	"input-fields-complete",
	"permission-callback-input-equals-tool-input-if-invoked",
	"tool-result-exact",
	"desktop-card-intent-complete",
	"fixture-state-exact",
	"every-offered-mode-observed",
];

const SCENARIOS: readonly DesktopPermissionProbeScenario[] = [
	{
		id: "read-range",
		tool: "Read",
		fixtureClass: "synthetic-text",
		comparison: "stock-parity",
		inputFields: ["file_path", "offset", "limit"],
		facets: READ_FACETS,
		evidenceChannels: READ_CHANNELS,
		assertions: [...BASE_ASSERTIONS, "stock-patched-parity"],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "read-show-whitespace",
		tool: "Read",
		fixtureClass: "synthetic-text",
		comparison: "extension-delta",
		inputFields: ["file_path", "show_whitespace"],
		facets: READ_FACETS,
		evidenceChannels: READ_CHANNELS,
		assertions: [...BASE_ASSERTIONS, "extension-behavior-exact"],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "read-bounded-large-file",
		tool: "Read",
		fixtureClass: "synthetic-large-text",
		comparison: "extension-delta",
		inputFields: ["file_path", "offset", "limit"],
		facets: READ_FACETS,
		evidenceChannels: READ_CHANNELS,
		assertions: [...BASE_ASSERTIONS, "extension-behavior-exact"],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "read-stock-media",
		tool: "Read",
		fixtureClass: "synthetic-media",
		comparison: "stock-parity",
		inputFields: ["file_path"],
		facets: READ_FACETS,
		evidenceChannels: READ_CHANNELS,
		assertions: [...BASE_ASSERTIONS, "stock-patched-parity"],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "edit-single",
		tool: "Edit",
		fixtureClass: "synthetic-text",
		comparison: "stock-parity",
		inputFields: ["file_path", "old_string", "new_string", "replace_all"],
		facets: EDIT_FACETS,
		evidenceChannels: MUTATION_CHANNELS,
		assertions: [
			...BASE_ASSERTIONS,
			"approval-outcome-recorded",
			"before-after-diff-exact",
			"stock-patched-parity",
		],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "edit-batch",
		tool: "Edit",
		fixtureClass: "synthetic-text",
		comparison: "extension-delta",
		inputFields: [
			"file_path",
			"edits[]",
			"edits[].old_string",
			"edits[].new_string",
			"edits[].replace_all",
		],
		facets: EDIT_FACETS,
		evidenceChannels: MUTATION_CHANNELS,
		assertions: [
			...BASE_ASSERTIONS,
			"approval-outcome-recorded",
			"all-batch-diffs-complete",
			"extension-behavior-exact",
		],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "write-create",
		tool: "Write",
		fixtureClass: "synthetic-text",
		comparison: "stock-parity",
		inputFields: ["file_path", "content"],
		facets: WRITE_FACETS,
		evidenceChannels: MUTATION_CHANNELS,
		assertions: [
			...BASE_ASSERTIONS,
			"approval-outcome-recorded",
			"create-overwrite-intent-complete",
			"stock-patched-parity",
		],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "write-overwrite",
		tool: "Write",
		fixtureClass: "synthetic-text",
		comparison: "stock-parity",
		inputFields: ["file_path", "content"],
		facets: WRITE_FACETS,
		evidenceChannels: MUTATION_CHANNELS,
		assertions: [
			...BASE_ASSERTIONS,
			"approval-outcome-recorded",
			"before-after-diff-exact",
			"create-overwrite-intent-complete",
			"stock-patched-parity",
		],
		modeCoverage: "every-offered-mode",
	},
	{
		id: "write-modified-since-read",
		tool: "Write",
		fixtureClass: "synthetic-text",
		comparison: "safety-rejection",
		inputFields: ["file_path", "content"],
		facets: WRITE_FACETS,
		evidenceChannels: MUTATION_CHANNELS,
		assertions: [
			"input-fields-complete",
			"permission-callback-input-equals-tool-input-if-invoked",
			"approval-outcome-recorded",
			"modified-since-read-rejected",
			"fixture-state-exact",
			"every-offered-mode-observed",
		],
		modeCoverage: "every-offered-mode",
	},
];

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new Error("Desktop permission probe plan contains undefined data");
	}
	return encoded;
}

function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function copyFacet(
	facet: DesktopPermissionProbeFacet,
): DesktopPermissionProbeFacet {
	return {
		...facet,
		tools: [...facet.tools],
		requiredProbeIds: [...facet.requiredProbeIds],
		evidenceChannels: [...facet.evidenceChannels],
	};
}

function copyScenario(
	scenario: DesktopPermissionProbeScenario,
): DesktopPermissionProbeScenario {
	return {
		...scenario,
		inputFields: [...scenario.inputFields],
		facets: [...scenario.facets],
		evidenceChannels: [...scenario.evidenceChannels],
		assertions: [...scenario.assertions],
	};
}

function assemblePlan(
	binding: DesktopPermissionProbePlanEvidence["sdkContractBinding"],
): DesktopPermissionProbePlanEvidence {
	return {
		schemaVersion: DESKTOP_PERMISSION_PROBE_PLAN_SCHEMA_VERSION,
		sdkContractBinding: { ...binding },
		facets: FACETS.map(copyFacet),
		scenarios: SCENARIOS.map(copyScenario),
		permissionModes: {
			declaredSdkModes: [
				"default",
				"acceptEdits",
				"bypassPermissions",
				"plan",
				"dontAsk",
				"auto",
			],
			availability: "live-observation-required",
			requiredCoverage: "every-offered-mode",
			notOfferedHandling: "record-not-offered",
			callbackNotInvokedHandling: "record-without-satisfying-permission-input",
		},
		protocol: {
			lanes: ["stock-baseline", "patched-candidate"],
			stages: [
				"preflight",
				"stock-baseline",
				"patched-candidate",
				"restart-resume",
				"cleanup-rollback",
			],
			preflightRequirements: [
				"exact-target-selected",
				"explicit-consent-recorded",
				"artifact-and-profile-bound",
				"isolated-synthetic-fixtures",
				"stock-baseline-available",
				"rollback-ready",
			],
			completionRequirements: [
				"all-offered-modes-classified",
				"all-scenarios-observed-in-required-lanes",
				"structured-and-ui-evidence-correlated",
				"restart-resume-passed",
				"durable-evidence-sanitized",
				"cleanup-and-rollback-recorded",
			],
		},
		evidencePolicy: {
			fixtures: "isolated-synthetic-only",
			rawCapture: "ephemeral-local-only",
			durableEvidence: "sanitized-assertions-only",
			forbiddenData: [
				"local-paths",
				"user-identifiers",
				"process-identifiers",
				"session-identifiers",
				"credentials",
				"environment-values",
				"source-excerpts",
				"fixture-contents",
			],
		},
		boundaries: {
			targetSelection: "required",
			consent: "required",
			mutationAuthorization: "not-authorized",
			execution: "not-run",
			profileSelection: "blocked",
			bundledRuntimeIdentity: "not-proven",
			uiProjection: "not-run",
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new Error(`${label} field shape is invalid`);
	}
}

function readBinding(
	value: unknown,
): DesktopPermissionProbePlanEvidence["sdkContractBinding"] {
	if (!isRecord(value)) {
		throw new Error("Desktop permission probe SDK contract binding is invalid");
	}
	assertExactKeys(
		value,
		[
			"sha256",
			"inventorySha256",
			"platform",
			"desktopVersion",
			"packagedAgentSdkVersion",
		],
		"Desktop permission probe SDK contract binding",
	);
	if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
		throw new Error("Desktop permission probe SDK contract SHA256 is invalid");
	}
	if (
		typeof value.inventorySha256 !== "string" ||
		!SHA256_RE.test(value.inventorySha256)
	) {
		throw new Error("Desktop permission probe inventory SHA256 is invalid");
	}
	if (
		typeof value.platform !== "string" ||
		!DESKTOP_PLATFORMS.has(value.platform)
	) {
		throw new Error("Desktop permission probe platform is invalid");
	}
	if (
		typeof value.desktopVersion !== "string" ||
		!VERSION_RE.test(value.desktopVersion)
	) {
		throw new Error("Desktop permission probe Desktop version is invalid");
	}
	if (
		typeof value.packagedAgentSdkVersion !== "string" ||
		!VERSION_RE.test(value.packagedAgentSdkVersion)
	) {
		throw new Error("Desktop permission probe SDK version is invalid");
	}
	return {
		sha256: value.sha256,
		inventorySha256: value.inventorySha256,
		platform: value.platform as DesktopPlatform,
		desktopVersion: value.desktopVersion,
		packagedAgentSdkVersion: value.packagedAgentSdkVersion,
	};
}

function bindingFor(
	sdkContract: DesktopSdkContractEvidence,
): DesktopPermissionProbePlanEvidence["sdkContractBinding"] {
	return {
		sha256: canonicalSha256(sdkContract),
		inventorySha256: sdkContract.inventoryBinding.sha256,
		platform: sdkContract.inventoryBinding.platform,
		desktopVersion: sdkContract.inventoryBinding.desktopVersion,
		packagedAgentSdkVersion:
			sdkContract.inventoryBinding.packagedAgentSdkVersion,
	};
}

export function validateDesktopPermissionProbePlanEvidence(
	value: unknown,
	sdkContract?: DesktopSdkContractEvidence,
): asserts value is DesktopPermissionProbePlanEvidence {
	if (!isRecord(value)) {
		throw new Error("Desktop permission probe plan must be an object");
	}
	assertExactKeys(
		value,
		[
			"schemaVersion",
			"sdkContractBinding",
			"facets",
			"scenarios",
			"permissionModes",
			"protocol",
			"evidencePolicy",
			"boundaries",
		],
		"Desktop permission probe plan contract",
	);
	if (value.schemaVersion !== DESKTOP_PERMISSION_PROBE_PLAN_SCHEMA_VERSION) {
		throw new Error(
			"Desktop permission probe plan schemaVersion is unsupported",
		);
	}
	const binding = readBinding(value.sdkContractBinding);
	if (sdkContract) {
		validateDesktopSdkContractEvidence(sdkContract);
		if (canonicalJson(binding) !== canonicalJson(bindingFor(sdkContract))) {
			throw new Error("Desktop permission probe SDK contract binding mismatch");
		}
	}
	const expected = assemblePlan(binding);
	if (canonicalJson(value) !== canonicalJson(expected)) {
		throw new Error(
			"Desktop permission probe plan contract shape or required coverage drifted",
		);
	}
}

export function createDesktopPermissionProbePlan(
	sdkContract: DesktopSdkContractEvidence,
): DesktopPermissionProbePlanEvidence {
	validateDesktopSdkContractEvidence(sdkContract);
	const plan = assemblePlan(bindingFor(sdkContract));
	validateDesktopPermissionProbePlanEvidence(plan, sdkContract);
	return plan;
}

function hasSameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

export async function readDesktopSdkContractEvidenceFile(
	filePath: string,
): Promise<DesktopSdkContractEvidence> {
	const pathStat = await fs.lstat(filePath);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
		throw new Error("Desktop SDK contract input must be a real regular file");
	}
	if (pathStat.size < 2 || pathStat.size > MAX_EVIDENCE_BYTES) {
		throw new Error("Desktop SDK contract input size exceeds limit");
	}
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		if (!hasSameFileIdentity(pathStat, before)) {
			throw new Error("Desktop SDK contract input changed before reading");
		}
		const contents = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat();
		if (!hasSameFileIdentity(before, after)) {
			throw new Error("Desktop SDK contract input changed while reading");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(contents);
		} catch (error) {
			throw new Error("Desktop SDK contract JSON is invalid", { cause: error });
		}
		const evidence = parsed as DesktopSdkContractEvidence;
		validateDesktopSdkContractEvidence(evidence);
		return evidence;
	} finally {
		await handle.close();
	}
}
