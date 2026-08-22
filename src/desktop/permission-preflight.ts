import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import {
	type PatchSurfaceReadiness,
	validatePatchSupportEvidence,
} from "../profiles/readiness.js";
import {
	isNativeArtifactPlatform,
	type NativeArtifactPlatform,
	type NativeBinaryFormat,
} from "../targets/contract.js";
import {
	type DesktopArtifactInspectionEvidence,
	validateDesktopArtifactInspectionEvidence,
} from "./artifact-inspection.js";
import {
	type DesktopInventoryEvidence,
	type DesktopPlatform,
	validateDesktopInventoryEvidence,
} from "./contract.js";
import {
	type DesktopPermissionProbePlanEvidence,
	validateDesktopPermissionProbePlanEvidence,
} from "./permission-probe.js";
import {
	type DesktopSdkContractEvidence,
	validateDesktopSdkContractEvidence,
} from "./sdk-contract.js";

export const DESKTOP_PERMISSION_PREFLIGHT_SCHEMA_VERSION = 1 as const;

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const LOCATOR_ID_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

export type DesktopPermissionPreflightResponsibility =
	| "repository"
	| "owner"
	| "matching-host"
	| "operator";

export type DesktopPermissionPreflightGateId =
	| "receipt-contracts"
	| "sdk-inventory-binding"
	| "plan-sdk-binding"
	| "artifact-inventory-binding"
	| "official-stock-identity"
	| "platform-signature-presence"
	| "platform-signature-validity"
	| "owner-target-selection"
	| "stock-baseline-consent"
	| "desktop-profile-boundary"
	| "isolated-synthetic-workspace"
	| "cleanup-preparation";

export interface DesktopPermissionPreflightPaths {
	inventoryPath: string;
	artifactPath: string;
	sdkContractPath: string;
	probePlanPath: string;
	profileSupportPath: string;
}

export interface DesktopPermissionPreflightInputs {
	inventory: DesktopInventoryEvidence;
	artifact: DesktopArtifactInspectionEvidence;
	sdkContract: DesktopSdkContractEvidence;
	probePlan: DesktopPermissionProbePlanEvidence;
	profileSupport: PatchSurfaceReadiness;
}

export interface DesktopPermissionPreflightGate {
	id: DesktopPermissionPreflightGateId;
	status: "pass" | "blocked";
	responsibility: DesktopPermissionPreflightResponsibility;
	detail: string;
}

export interface DesktopPermissionPreflightBlocker {
	code:
		| "matching-host-signature-validity-required"
		| "owner-target-selection-required"
		| "owner-stock-baseline-consent-required"
		| "isolated-synthetic-workspace-required"
		| "cleanup-preparation-required";
	responsibility: Exclude<
		DesktopPermissionPreflightResponsibility,
		"repository"
	>;
	requirement: string;
}

export interface DesktopPermissionPreflightTarget {
	desktopLocatorId: string;
	desktopVersion: string;
	packagedAgentSdkVersion: string;
	codeLocatorId: string;
	codeVersion: string;
	platform: DesktopPlatform;
	nativePlatform: NativeArtifactPlatform;
	binaryFormat: NativeBinaryFormat;
	architecture: "x64" | "arm64";
	size: number;
	sha256: string;
	inventorySelectionReason: "declared-pin" | "highest-cached";
}

export interface DesktopPermissionPreflightEvidence {
	schemaVersion: typeof DESKTOP_PERMISSION_PREFLIGHT_SCHEMA_VERSION;
	bindings: {
		inventorySha256: string;
		artifactSha256: string;
		sdkContractSha256: string;
		probePlanSha256: string;
		profileSupportSha256: string;
	};
	target: DesktopPermissionPreflightTarget;
	gates: DesktopPermissionPreflightGate[];
	blockers: DesktopPermissionPreflightBlocker[];
	readyForStockBaseline: boolean;
	boundaries: {
		readOnly: true;
		desktopLaunch: "not-authorized";
		managedArtifactMutation: "not-authorized";
		patchedCandidate: "closed";
		profileSelection: "blocked";
		remoteControl: "closed";
		selfHosted: "closed";
		execution: "not-run";
	};
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
	value: unknown,
	expected: readonly string[],
	label: string,
): asserts value is JsonObject {
	if (!isObject(value)) throw new Error(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new Error(`${label} field shape is invalid`);
	}
}

function assertNoDuplicateJsonKeys(input: string, label: string): void {
	let index = 0;
	const skipWhitespace = () => {
		while (/\s/.test(input[index] ?? "")) index += 1;
	};
	const parseString = (): string => {
		if (input[index] !== '"') throw new Error(`${label} contains invalid JSON`);
		const start = index;
		index += 1;
		while (index < input.length) {
			const character = input[index];
			if (character === "\\") {
				index += 2;
				continue;
			}
			index += 1;
			if (character === '"') {
				try {
					return JSON.parse(input.slice(start, index)) as string;
				} catch (error) {
					throw new Error(`${label} contains invalid JSON`, { cause: error });
				}
			}
		}
		throw new Error(`${label} contains an unterminated JSON string`);
	};
	const parseValue = (depth: number): void => {
		if (depth > 64) throw new Error(`${label} JSON depth exceeds limit`);
		skipWhitespace();
		const character = input[index];
		if (character === "{") {
			index += 1;
			skipWhitespace();
			const keys = new Set<string>();
			if (input[index] === "}") {
				index += 1;
				return;
			}
			for (;;) {
				skipWhitespace();
				const key = parseString();
				if (keys.has(key)) throw new Error(`${label} has duplicate key ${key}`);
				keys.add(key);
				skipWhitespace();
				if (input[index] !== ":") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
				parseValue(depth + 1);
				skipWhitespace();
				if (input[index] === "}") {
					index += 1;
					return;
				}
				if (input[index] !== ",") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
			}
		}
		if (character === "[") {
			index += 1;
			skipWhitespace();
			if (input[index] === "]") {
				index += 1;
				return;
			}
			for (;;) {
				parseValue(depth + 1);
				skipWhitespace();
				if (input[index] === "]") {
					index += 1;
					return;
				}
				if (input[index] !== ",") {
					throw new Error(`${label} contains invalid JSON`);
				}
				index += 1;
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		const primitive = input
			.slice(index)
			.match(
				/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
			)?.[0];
		if (!primitive) throw new Error(`${label} contains invalid JSON`);
		index += primitive.length;
	};
	parseValue(0);
	skipWhitespace();
	if (index !== input.length) {
		throw new Error(`${label} contains trailing JSON data`);
	}
}

function parseJson(input: Buffer, label: string): unknown {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8`, { cause: error });
	}
	assertNoDuplicateJsonKeys(text, label);
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${label} contains invalid JSON`, { cause: error });
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Canonical JSON number is invalid");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("Canonical JSON contains an unsupported value");
}

function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function readStableEvidence(
	filePath: string,
	label: string,
): Promise<unknown> {
	const pathBefore = await fs.lstat(filePath);
	if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
		throw new Error(`${label} must be a real regular file`);
	}
	if (pathBefore.size < 2 || pathBefore.size > MAX_EVIDENCE_BYTES) {
		throw new Error(`${label} size exceeds limit`);
	}
	const handle = await fs.open(filePath, "r");
	try {
		const handleBefore = await handle.stat();
		if (!sameFileIdentity(pathBefore, handleBefore)) {
			throw new Error(`${label} changed before reading`);
		}
		const contents = await handle.readFile();
		const [handleAfter, pathAfter] = await Promise.all([
			handle.stat(),
			fs.lstat(filePath),
		]);
		if (
			!sameFileIdentity(handleBefore, handleAfter) ||
			!sameFileIdentity(pathBefore, pathAfter)
		) {
			throw new Error(`${label} changed while reading`);
		}
		return parseJson(contents, label);
	} finally {
		await handle.close();
	}
}

export async function readDesktopPermissionPreflightInputs(
	paths: DesktopPermissionPreflightPaths,
): Promise<DesktopPermissionPreflightInputs> {
	const inventory = (await readStableEvidence(
		paths.inventoryPath,
		"Desktop inventory evidence",
	)) as DesktopInventoryEvidence;
	validateDesktopInventoryEvidence(inventory);
	const artifact = (await readStableEvidence(
		paths.artifactPath,
		"Desktop artifact evidence",
	)) as DesktopArtifactInspectionEvidence;
	validateDesktopArtifactInspectionEvidence(artifact);
	const sdkContract = (await readStableEvidence(
		paths.sdkContractPath,
		"Desktop SDK contract evidence",
	)) as DesktopSdkContractEvidence;
	validateDesktopSdkContractEvidence(sdkContract);
	const probePlan = (await readStableEvidence(
		paths.probePlanPath,
		"Desktop permission probe plan evidence",
	)) as DesktopPermissionProbePlanEvidence;
	validateDesktopPermissionProbePlanEvidence(probePlan, sdkContract);
	const profileSupport = validatePatchSupportEvidence(
		await readStableEvidence(
			paths.profileSupportPath,
			"Desktop profile support evidence",
		),
	);
	return { inventory, artifact, sdkContract, probePlan, profileSupport };
}

function expectedClassification(platform: NativeArtifactPlatform): {
	desktopPlatform: DesktopPlatform;
	format: NativeBinaryFormat;
	architecture: "x64" | "arm64";
} {
	const architecture = platform.includes("arm64") ? "arm64" : "x64";
	if (platform.startsWith("win32-")) {
		return { desktopPlatform: "win32", format: "pe", architecture };
	}
	if (platform.startsWith("darwin-")) {
		return { desktopPlatform: "darwin", format: "macho", architecture };
	}
	return { desktopPlatform: "linux", format: "elf", architecture };
}

function assertInputChain(
	inputs: DesktopPermissionPreflightInputs,
): DesktopPermissionPreflightTarget {
	validateDesktopInventoryEvidence(inputs.inventory);
	validateDesktopArtifactInspectionEvidence(inputs.artifact);
	validateDesktopSdkContractEvidence(inputs.sdkContract);
	validateDesktopPermissionProbePlanEvidence(
		inputs.probePlan,
		inputs.sdkContract,
	);
	validatePatchSupportEvidence(inputs.profileSupport);

	const desktop = inputs.inventory.desktop;
	const selected = inputs.inventory.cachedCode.find(
		(row) => row.locatorId === inputs.inventory.selectedCodeLocatorId,
	);
	if (
		desktop?.packagedAgentSdk.status !== "resolved" ||
		!selected ||
		selected.platform === null ||
		selected.binaryFormat === "unknown" ||
		selected.architecture === "unknown" ||
		inputs.inventory.selectedCodeReason === null
	) {
		throw new Error("Desktop preflight inventory selection is incomplete");
	}
	const inventorySha256 = canonicalSha256(inputs.inventory);
	if (
		inputs.sdkContract.inventoryBinding.sha256 !== inventorySha256 ||
		inputs.sdkContract.inventoryBinding.platform !==
			inputs.inventory.platform ||
		inputs.sdkContract.inventoryBinding.desktopLocatorId !==
			desktop.locatorId ||
		inputs.sdkContract.inventoryBinding.desktopVersion !== desktop.version ||
		inputs.sdkContract.inventoryBinding.packagedAgentSdkVersion !==
			desktop.packagedAgentSdk.version
	) {
		throw new Error("Desktop SDK and inventory binding mismatch");
	}
	const artifact = inputs.artifact;
	if (
		artifact.platform !== inputs.inventory.platform ||
		artifact.locatorId !== selected.locatorId ||
		artifact.version !== selected.version ||
		artifact.nativePlatform !== selected.platform ||
		artifact.binaryFormat !== selected.binaryFormat ||
		artifact.architecture !== selected.architecture ||
		artifact.size !== selected.size ||
		artifact.sha256 !== selected.sha256 ||
		artifact.selectionReason !== inputs.inventory.selectedCodeReason
	) {
		throw new Error("Desktop artifact and inventory identity binding mismatch");
	}
	if (
		artifact.provenance.status !== "verified" ||
		artifact.provenance.manifestSha256 !== artifact.sha256 ||
		artifact.provenance.manifestSize !== artifact.size
	) {
		throw new Error("Desktop official stock provenance is not verified");
	}
	if (artifact.patchReceipt.status !== "absent") {
		throw new Error(
			"Desktop stock identity requires an inspected absent patch receipt",
		);
	}
	if (
		artifact.platform !== "linux" &&
		artifact.platformSignature.presence !== "present"
	) {
		throw new Error("Desktop platform signature presence is required");
	}
	const profile = inputs.profileSupport;
	if (
		profile.surface !== "desktop-local" ||
		profile.profile !== "desktop-local" ||
		profile.selectable ||
		profile.readiness !== "blocked" ||
		profile.summary.total !== 46 ||
		profile.summary.supported !== 0 ||
		profile.summary.probeRequired !== 31 ||
		profile.summary.excluded !== 15 ||
		profile.summary.notAssessed !== 0
	) {
		throw new Error("Desktop profile support boundary drifted");
	}
	return {
		desktopLocatorId: desktop.locatorId,
		desktopVersion: desktop.version,
		packagedAgentSdkVersion: desktop.packagedAgentSdk.version,
		codeLocatorId: artifact.locatorId,
		codeVersion: artifact.version,
		platform: artifact.platform,
		nativePlatform: artifact.nativePlatform,
		binaryFormat: artifact.binaryFormat,
		architecture: artifact.architecture,
		size: artifact.size,
		sha256: artifact.sha256,
		inventorySelectionReason: artifact.selectionReason,
	};
}

function buildGates(
	target: DesktopPermissionPreflightTarget,
): DesktopPermissionPreflightGate[] {
	const signatureValidityRequired = target.platform !== "linux";
	return [
		{
			id: "receipt-contracts",
			status: "pass",
			responsibility: "repository",
			detail: "All five input receipts satisfy their strict runtime contracts.",
		},
		{
			id: "sdk-inventory-binding",
			status: "pass",
			responsibility: "repository",
			detail: "The SDK contract binds the exact canonical Desktop inventory.",
		},
		{
			id: "plan-sdk-binding",
			status: "pass",
			responsibility: "repository",
			detail: "The permission plan binds the exact canonical SDK contract.",
		},
		{
			id: "artifact-inventory-binding",
			status: "pass",
			responsibility: "repository",
			detail:
				"Artifact identity matches the inventory-selected cache row exactly.",
		},
		{
			id: "official-stock-identity",
			status: "pass",
			responsibility: "repository",
			detail:
				"Official manifest bytes match and the deep patch-receipt inspection is absent.",
		},
		{
			id: "platform-signature-presence",
			status: "pass",
			responsibility: "repository",
			detail:
				target.platform === "linux"
					? "Platform signature presence is not applicable to this ELF target."
					: "The expected platform signature structure is present.",
		},
		{
			id: "platform-signature-validity",
			status: signatureValidityRequired ? "blocked" : "pass",
			responsibility: signatureValidityRequired
				? "matching-host"
				: "repository",
			detail: signatureValidityRequired
				? "Matching-host cryptographic validity and trust policy are not recorded."
				: "No platform signing validity gate applies to this ELF target.",
		},
		{
			id: "owner-target-selection",
			status: "blocked",
			responsibility: "owner",
			detail: `The inventory source is ${target.inventorySelectionReason}; explicit owner selection is absent.`,
		},
		{
			id: "stock-baseline-consent",
			status: "blocked",
			responsibility: "owner",
			detail:
				"Stock-only synthetic Read/Edit/Write execution is not authorized.",
		},
		{
			id: "desktop-profile-boundary",
			status: "pass",
			responsibility: "repository",
			detail:
				"Desktop profile support remains blocked, non-selectable, and zero-supported.",
		},
		{
			id: "isolated-synthetic-workspace",
			status: "blocked",
			responsibility: "operator",
			detail: "An isolated synthetic workspace has not been prepared.",
		},
		{
			id: "cleanup-preparation",
			status: "blocked",
			responsibility: "operator",
			detail: "Synthetic fixture cleanup evidence has not been prepared.",
		},
	];
}

function buildBlockers(
	gates: readonly DesktopPermissionPreflightGate[],
): DesktopPermissionPreflightBlocker[] {
	const blocked = new Set(
		gates.filter((gate) => gate.status === "blocked").map((gate) => gate.id),
	);
	const blockers: DesktopPermissionPreflightBlocker[] = [];
	if (blocked.has("platform-signature-validity")) {
		blockers.push({
			code: "matching-host-signature-validity-required",
			responsibility: "matching-host",
			requirement:
				"Record matching-host signature validity and host trust policy for the exact artifact.",
		});
	}
	blockers.push(
		{
			code: "owner-target-selection-required",
			responsibility: "owner",
			requirement:
				"Record explicit owner target selection for the exact bound Desktop Code target.",
		},
		{
			code: "owner-stock-baseline-consent-required",
			responsibility: "owner",
			requirement:
				"Record explicit owner stock-baseline consent for Read, Edit, and Write in an isolated synthetic workspace.",
		},
		{
			code: "isolated-synthetic-workspace-required",
			responsibility: "operator",
			requirement: "Prepare isolated synthetic fixtures after owner consent.",
		},
		{
			code: "cleanup-preparation-required",
			responsibility: "operator",
			requirement: "Prepare deterministic fixture cleanup evidence.",
		},
	);
	return blockers;
}

function assembleEvidence(
	inputs: DesktopPermissionPreflightInputs,
): DesktopPermissionPreflightEvidence {
	const target = assertInputChain(inputs);
	const gates = buildGates(target);
	return {
		schemaVersion: DESKTOP_PERMISSION_PREFLIGHT_SCHEMA_VERSION,
		bindings: {
			inventorySha256: canonicalSha256(inputs.inventory),
			artifactSha256: canonicalSha256(inputs.artifact),
			sdkContractSha256: canonicalSha256(inputs.sdkContract),
			probePlanSha256: canonicalSha256(inputs.probePlan),
			profileSupportSha256: canonicalSha256(inputs.profileSupport),
		},
		target,
		gates,
		blockers: buildBlockers(gates),
		readyForStockBaseline: gates.every((gate) => gate.status === "pass"),
		boundaries: {
			readOnly: true,
			desktopLaunch: "not-authorized",
			managedArtifactMutation: "not-authorized",
			patchedCandidate: "closed",
			profileSelection: "blocked",
			remoteControl: "closed",
			selfHosted: "closed",
			execution: "not-run",
		},
	};
}

function readTarget(value: unknown): DesktopPermissionPreflightTarget {
	assertExactKeys(
		value,
		[
			"desktopLocatorId",
			"desktopVersion",
			"packagedAgentSdkVersion",
			"codeLocatorId",
			"codeVersion",
			"platform",
			"nativePlatform",
			"binaryFormat",
			"architecture",
			"size",
			"sha256",
			"inventorySelectionReason",
		],
		"Desktop permission preflight target",
	);
	if (
		typeof value.desktopLocatorId !== "string" ||
		!LOCATOR_ID_RE.test(value.desktopLocatorId) ||
		typeof value.codeLocatorId !== "string" ||
		!LOCATOR_ID_RE.test(value.codeLocatorId) ||
		typeof value.desktopVersion !== "string" ||
		!VERSION_RE.test(value.desktopVersion) ||
		typeof value.packagedAgentSdkVersion !== "string" ||
		!VERSION_RE.test(value.packagedAgentSdkVersion) ||
		typeof value.codeVersion !== "string" ||
		!VERSION_RE.test(value.codeVersion) ||
		value.desktopLocatorId !== `desktop:${value.desktopVersion}` ||
		value.codeLocatorId !== `desktop-code:${value.codeVersion}` ||
		typeof value.nativePlatform !== "string" ||
		!isNativeArtifactPlatform(value.nativePlatform) ||
		typeof value.platform !== "string" ||
		(value.platform !== "linux" &&
			value.platform !== "darwin" &&
			value.platform !== "win32") ||
		typeof value.binaryFormat !== "string" ||
		(value.binaryFormat !== "elf" &&
			value.binaryFormat !== "macho" &&
			value.binaryFormat !== "pe") ||
		(value.architecture !== "x64" && value.architecture !== "arm64") ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 1 ||
		value.size > 1024 * 1024 * 1024 ||
		typeof value.sha256 !== "string" ||
		!SHA256_RE.test(value.sha256) ||
		(value.inventorySelectionReason !== "declared-pin" &&
			value.inventorySelectionReason !== "highest-cached")
	) {
		throw new Error("Desktop permission preflight target is invalid");
	}
	const expected = expectedClassification(value.nativePlatform);
	if (
		expected.desktopPlatform !== value.platform ||
		expected.format !== value.binaryFormat ||
		expected.architecture !== value.architecture
	) {
		throw new Error(
			"Desktop permission preflight target classification drifted",
		);
	}
	return value as unknown as DesktopPermissionPreflightTarget;
}

export function validateDesktopPermissionPreflightEvidence(
	value: unknown,
	inputs?: DesktopPermissionPreflightInputs,
): asserts value is DesktopPermissionPreflightEvidence {
	assertExactKeys(
		value,
		[
			"schemaVersion",
			"bindings",
			"target",
			"gates",
			"blockers",
			"readyForStockBaseline",
			"boundaries",
		],
		"Desktop permission preflight evidence",
	);
	if (value.schemaVersion !== DESKTOP_PERMISSION_PREFLIGHT_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop permission preflight schemaVersion");
	}
	assertExactKeys(
		value.bindings,
		[
			"inventorySha256",
			"artifactSha256",
			"sdkContractSha256",
			"probePlanSha256",
			"profileSupportSha256",
		],
		"Desktop permission preflight bindings",
	);
	if (
		Object.values(value.bindings).some(
			(digest) => typeof digest !== "string" || !SHA256_RE.test(digest),
		)
	) {
		throw new Error("Desktop permission preflight binding SHA256 is invalid");
	}
	const target = readTarget(value.target);
	const expectedGates = buildGates(target);
	if (canonicalJson(value.gates) !== canonicalJson(expectedGates)) {
		throw new Error("Desktop permission preflight gate contract drifted");
	}
	const expectedBlockers = buildBlockers(expectedGates);
	if (canonicalJson(value.blockers) !== canonicalJson(expectedBlockers)) {
		throw new Error("Desktop permission preflight blocker contract drifted");
	}
	if (value.readyForStockBaseline !== false) {
		throw new Error("Desktop permission preflight readiness is overstated");
	}
	const expectedBoundaries: DesktopPermissionPreflightEvidence["boundaries"] = {
		readOnly: true,
		desktopLaunch: "not-authorized",
		managedArtifactMutation: "not-authorized",
		patchedCandidate: "closed",
		profileSelection: "blocked",
		remoteControl: "closed",
		selfHosted: "closed",
		execution: "not-run",
	};
	if (canonicalJson(value.boundaries) !== canonicalJson(expectedBoundaries)) {
		throw new Error("Desktop permission preflight safety boundary drifted");
	}
	if (inputs) {
		const expected = assembleEvidence(inputs);
		if (canonicalJson(value) !== canonicalJson(expected)) {
			throw new Error("Desktop permission preflight receipt binding mismatch");
		}
	}
}

export function createDesktopPermissionPreflight(
	inputs: DesktopPermissionPreflightInputs,
): DesktopPermissionPreflightEvidence {
	const evidence = assembleEvidence(inputs);
	validateDesktopPermissionPreflightEvidence(evidence, inputs);
	return evidence;
}
