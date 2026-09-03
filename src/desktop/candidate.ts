import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import type { NativeBuildResult } from "../operations/contract.js";
import { profilePatchCatalog } from "../patches/index.js";
import {
	type ResolvedPatchSelection,
	resolvePatchSelection,
} from "../patching/selection.js";
import type {
	PatchProfileExclusion,
	PatchProfileReceipt,
} from "../profiles/contract.js";
import {
	DESKTOP_LOCAL_CANDIDATE_TAGS,
	DESKTOP_LOCAL_EXCLUSIONS,
	DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS,
	DESKTOP_LOCAL_POLICY_EXCLUSIONS,
	DESKTOP_LOCAL_REQUIRED_PROBES,
	desktopLocalCandidateProfile,
} from "../profiles/desktop-local.js";
import {
	type PatchSurfaceReadiness,
	validatePatchSupportEvidence,
} from "../profiles/readiness.js";
import {
	type ArtifactReceipt,
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
	type DesktopPermissionPreflightEvidence,
	type DesktopPermissionPreflightInputs,
	type DesktopPermissionPreflightPaths,
	type DesktopPermissionPreflightTarget,
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

export const DESKTOP_CANDIDATE_SCHEMA_VERSION = 1 as const;

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;

type JsonObject = Record<string, unknown>;

export interface DesktopCandidateEvidencePaths
	extends DesktopPermissionPreflightPaths {
	stockPreflightPath: string;
	stockBaselinePath: string;
}

export interface DesktopCandidateFileBindings {
	inventoryFileSha256: string;
	artifactFileSha256: string;
	sdkContractFileSha256: string;
	probePlanFileSha256: string;
	profileSupportFileSha256: string;
	stockPreflightFileSha256: string;
	stockBaselineFileSha256: string;
	canonicalChain: DesktopPermissionPreflightEvidence["bindings"];
}

export interface DesktopCandidateContext {
	target: DesktopPermissionPreflightTarget;
	profileSupport: PatchSurfaceReadiness;
	bindings: DesktopCandidateFileBindings;
}

export interface DesktopCandidateNativeBuildRequest {
	version: string;
	platform: NativeArtifactPlatform;
	candidateRoot: string;
	patchSelection: ResolvedPatchSelection;
}

export type DesktopCandidateNativeBuilder = (
	request: DesktopCandidateNativeBuildRequest,
) => Promise<NativeBuildResult>;

export interface DesktopCandidateProfileEvidence extends PatchProfileReceipt {
	supportReadiness: "blocked";
	selectable: false;
	supportedClaims: 0;
}

export interface DesktopCandidateEvidence {
	schemaVersion: typeof DESKTOP_CANDIDATE_SCHEMA_VERSION;
	bindings: DesktopCandidateFileBindings;
	target: DesktopPermissionPreflightTarget;
	profile: DesktopCandidateProfileEvidence;
	candidate: {
		locatorId: string;
		source: "official-release-copy";
		cleanSha256: string;
		patchedSha256: string;
		size: number;
		binaryFormat: NativeBinaryFormat;
		patchVerification: "pass";
		structuralVerification: "pass";
		patchReceipt: "verified";
		signingPolicy: "unconfigured";
		signingVerification: "not-run";
		hostExecution: "not-run";
		desktopLaunch: "not-run";
		surfaceCompatibility: "not-evaluated";
	};
	boundaries: {
		separateCandidateCopy: true;
		managedArtifactMutation: "not-authorized";
		signing: "not-authorized";
		activation: "not-authorized";
		desktopLaunch: "not-authorized";
		profilePromotion: "blocked";
		remoteControl: "closed";
		selfHosted: "closed";
	};
	createdAt: string;
}

export interface DesktopCandidateBuildOutput {
	candidatePath: string;
	fromCache: boolean;
	profile: PatchProfileReceipt;
	artifactReceipt: ArtifactReceipt;
	evidence: DesktopCandidateEvidence;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
	if (!isObject(value)) throw new Error(`${label} must be an object`);
	return value;
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
): Promise<{ value: unknown; sha256: string }> {
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
		return {
			value: parseJson(contents, label),
			sha256: createHash("sha256").update(contents).digest("hex"),
		};
	} finally {
		await handle.close();
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Canonical JSON number is invalid");
		}
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

function assertJsonEqual(left: unknown, right: unknown, label: string): void {
	if (canonicalJson(left) !== canonicalJson(right)) {
		throw new Error(`${label} does not match`);
	}
}

function expectedPlatformShape(platform: NativeArtifactPlatform): {
	desktopPlatform: DesktopPlatform;
	binaryFormat: NativeBinaryFormat;
	architecture: "x64" | "arm64";
} {
	return {
		desktopPlatform: platform.startsWith("win32-")
			? "win32"
			: platform.startsWith("darwin-")
				? "darwin"
				: "linux",
		binaryFormat: platform.startsWith("win32-")
			? "pe"
			: platform.startsWith("darwin-")
				? "macho"
				: "elf",
		architecture: platform.includes("arm64") ? "arm64" : "x64",
	};
}

function validateStockBaseline(
	value: unknown,
	options: {
		target: DesktopPermissionPreflightTarget;
		bindings: Omit<DesktopCandidateFileBindings, "stockBaselineFileSha256">;
	},
): void {
	const receipt = requireObject(value, "Desktop stock baseline");
	if (
		receipt.schemaVersion !== 2 ||
		receipt.status !== "pass-with-stock-limitations"
	) {
		throw new Error("Desktop stock baseline completion status is invalid");
	}
	const target = requireObject(receipt.target, "Desktop stock baseline target");
	const expectedTarget = options.target;
	if (
		target.desktopLocatorId !== expectedTarget.desktopLocatorId ||
		target.desktopVersion !== expectedTarget.desktopVersion ||
		target.packagedAgentSdkVersion !== expectedTarget.packagedAgentSdkVersion ||
		target.codeLocatorId !== expectedTarget.codeLocatorId ||
		target.codeVersion !== expectedTarget.codeVersion ||
		target.nativePlatform !== expectedTarget.nativePlatform ||
		target.binaryFormat !== expectedTarget.binaryFormat ||
		target.architecture !== expectedTarget.architecture ||
		target.codeSize !== expectedTarget.size ||
		target.codeSha256 !== expectedTarget.sha256 ||
		target.officialProvenance !== "verified" ||
		target.embeddedPatchReceipt !== "absent"
	) {
		throw new Error("Desktop stock baseline target binding mismatch");
	}
	const authorization = requireObject(
		receipt.authorization,
		"Desktop stock baseline authorization",
	);
	if (
		authorization.received !== true ||
		authorization.stockBaselineOnly !== true ||
		authorization.patchedCandidate !== "not-authorized" ||
		authorization.desktopVersion !== expectedTarget.desktopVersion ||
		authorization.codeVersion !== expectedTarget.codeVersion ||
		authorization.codeSha256 !== expectedTarget.sha256
	) {
		throw new Error("Desktop stock baseline authorization history is invalid");
	}
	const receiptBindings = requireObject(
		receipt.receiptBindings,
		"Desktop stock baseline receipt bindings",
	);
	for (const key of [
		"inventoryFileSha256",
		"artifactFileSha256",
		"sdkContractFileSha256",
		"probePlanFileSha256",
		"profileSupportFileSha256",
		"stockPreflightFileSha256",
	] as const) {
		if (receiptBindings[key] !== options.bindings[key]) {
			throw new Error(`Desktop stock baseline ${key} binding mismatch`);
		}
	}
	assertJsonEqual(
		receiptBindings.canonicalChain,
		options.bindings.canonicalChain,
		"Desktop stock baseline canonical chain",
	);
	const completion = requireObject(
		receipt.completion,
		"Desktop stock baseline completion",
	);
	if (
		completion.stockBaselineComplete !== true ||
		completion.patchedCandidateReady !== false ||
		completion.profilePromotion !== "blocked"
	) {
		throw new Error("Desktop stock baseline completion boundary is invalid");
	}
	const noMutation = requireObject(
		receipt.noMutation,
		"Desktop stock baseline no-mutation evidence",
	);
	if (
		noMutation.codeSha256Before !== expectedTarget.sha256 ||
		noMutation.codeSha256After !== expectedTarget.sha256 ||
		noMutation.managedArtifactWrites !== 0 ||
		noMutation.status !== "pass"
	) {
		throw new Error("Desktop stock baseline no-mutation evidence is invalid");
	}
	const boundaries = requireObject(
		receipt.boundaries,
		"Desktop stock baseline boundaries",
	);
	if (
		boundaries.applicationJavaScriptMutation !== "not-used" ||
		boundaries.patchedCandidate !== "not-created" ||
		boundaries.remoteControl !== "not-entered"
	) {
		throw new Error("Desktop stock baseline safety boundary is invalid");
	}
}

export async function readDesktopCandidateContext(
	paths: DesktopCandidateEvidencePaths,
): Promise<DesktopCandidateContext> {
	const [
		inventoryFile,
		artifactFile,
		sdkContractFile,
		probePlanFile,
		profileSupportFile,
		stockPreflightFile,
		stockBaselineFile,
	] = await Promise.all([
		readStableEvidence(paths.inventoryPath, "Desktop inventory evidence"),
		readStableEvidence(paths.artifactPath, "Desktop artifact evidence"),
		readStableEvidence(paths.sdkContractPath, "Desktop SDK contract evidence"),
		readStableEvidence(paths.probePlanPath, "Desktop permission plan evidence"),
		readStableEvidence(paths.profileSupportPath, "Desktop profile evidence"),
		readStableEvidence(paths.stockPreflightPath, "Desktop stock preflight"),
		readStableEvidence(paths.stockBaselinePath, "Desktop stock baseline"),
	]);

	validateDesktopInventoryEvidence(
		inventoryFile.value as DesktopInventoryEvidence,
	);
	validateDesktopArtifactInspectionEvidence(
		artifactFile.value as DesktopArtifactInspectionEvidence,
	);
	validateDesktopSdkContractEvidence(
		sdkContractFile.value as DesktopSdkContractEvidence,
	);
	validateDesktopPermissionProbePlanEvidence(
		probePlanFile.value,
		sdkContractFile.value as DesktopSdkContractEvidence,
	);
	const profileSupport = validatePatchSupportEvidence(profileSupportFile.value);
	const preflightInputs: DesktopPermissionPreflightInputs = {
		inventory: inventoryFile.value as DesktopInventoryEvidence,
		artifact: artifactFile.value as DesktopArtifactInspectionEvidence,
		sdkContract: sdkContractFile.value as DesktopSdkContractEvidence,
		probePlan: probePlanFile.value as DesktopPermissionProbePlanEvidence,
		profileSupport,
	};
	validateDesktopPermissionPreflightEvidence(
		stockPreflightFile.value,
		preflightInputs,
	);
	const stockPreflight =
		stockPreflightFile.value as DesktopPermissionPreflightEvidence;
	const bindingsWithoutBaseline = {
		inventoryFileSha256: inventoryFile.sha256,
		artifactFileSha256: artifactFile.sha256,
		sdkContractFileSha256: sdkContractFile.sha256,
		probePlanFileSha256: probePlanFile.sha256,
		profileSupportFileSha256: profileSupportFile.sha256,
		stockPreflightFileSha256: stockPreflightFile.sha256,
		canonicalChain: structuredClone(stockPreflight.bindings),
	};
	validateStockBaseline(stockBaselineFile.value, {
		target: stockPreflight.target,
		bindings: bindingsWithoutBaseline,
	});
	return {
		target: structuredClone(stockPreflight.target),
		profileSupport,
		bindings: {
			...bindingsWithoutBaseline,
			stockBaselineFileSha256: stockBaselineFile.sha256,
		},
	};
}

async function hashStableRegularFile(
	filePath: string,
	label: string,
): Promise<{ sha256: string; size: number }> {
	const pathBefore = await fs.lstat(filePath);
	if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
		throw new Error(`${label} must be a real regular file`);
	}
	const handle = await fs.open(filePath, "r");
	try {
		const handleBefore = await handle.stat();
		if (!sameFileIdentity(pathBefore, handleBefore)) {
			throw new Error(`${label} changed before hashing`);
		}
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			hash.update(chunk);
		}
		const [handleAfter, pathAfter] = await Promise.all([
			handle.stat(),
			fs.lstat(filePath),
		]);
		if (
			!sameFileIdentity(handleBefore, handleAfter) ||
			!sameFileIdentity(pathBefore, pathAfter)
		) {
			throw new Error(`${label} changed while hashing`);
		}
		return { sha256: hash.digest("hex"), size: handleAfter.size };
	} finally {
		await handle.close();
	}
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative.length > 0 &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}

function assertProfileSupport(context: DesktopCandidateContext): void {
	const support = context.profileSupport;
	if (
		support.surface !== "desktop-local" ||
		support.profile !== "desktop-local" ||
		support.selectable ||
		support.readiness !== "blocked" ||
		support.summary.total !== 45 ||
		support.summary.supported !== 0 ||
		support.summary.probeRequired !== 30 ||
		support.summary.excluded !== 15 ||
		support.summary.notAssessed !== 0
	) {
		throw new Error("Desktop candidate profile support boundary drifted");
	}
	assertJsonEqual(
		support.candidateTags,
		DESKTOP_LOCAL_POLICY_CANDIDATE_TAGS,
		"Desktop policy candidate tag roster",
	);
	assertJsonEqual(
		support.patches
			.filter(({ support: level }) => level === "excluded")
			.map(({ tag, exclusionReason }) => ({ tag, reason: exclusionReason })),
		DESKTOP_LOCAL_POLICY_EXCLUSIONS,
		"Desktop policy exclusions",
	);
	assertJsonEqual(
		support.requiredProbes.map(({ id }) => id),
		DESKTOP_LOCAL_REQUIRED_PROBES,
		"Desktop candidate required probes",
	);
}

function rebindArtifactReceipt(
	receipt: ArtifactReceipt,
	target: DesktopPermissionPreflightTarget,
): ArtifactReceipt {
	return {
		...receipt,
		targetId: `desktop-local:${target.nativePlatform}:${target.codeVersion}`,
	};
}

export async function buildDesktopCandidate(options: {
	context: DesktopCandidateContext;
	candidateRoot: string;
	buildNative: DesktopCandidateNativeBuilder;
}): Promise<DesktopCandidateBuildOutput> {
	assertProfileSupport(options.context);
	const patchSelection = resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: desktopLocalCandidateProfile,
	});
	const candidateRoot = path.resolve(options.candidateRoot);
	const buildResult = await options.buildNative({
		version: options.context.target.codeVersion,
		platform: options.context.target.nativePlatform,
		candidateRoot,
		patchSelection,
	});
	if (buildResult.dryRun) {
		throw new Error("Desktop candidate construction returned a dry-run result");
	}
	const receipt = buildResult.artifactReceipt;
	if (!receipt) {
		throw new Error(
			"Desktop candidate construction omitted its artifact receipt",
		);
	}
	const target = options.context.target;
	const sourcePath = buildResult.fetchResult.binaryPath;
	const candidatePath = buildResult.patchOutputPath;
	const [rootPath, sourcePathReal, candidatePathReal] = await Promise.all([
		fs.realpath(candidateRoot),
		fs.realpath(sourcePath),
		fs.realpath(candidatePath),
	]);
	if (
		!isPathWithin(rootPath, sourcePathReal) ||
		!isPathWithin(rootPath, candidatePathReal) ||
		sourcePathReal === candidatePathReal
	) {
		throw new Error(
			"Desktop candidate clean and patched paths must be distinct inside the candidate root",
		);
	}
	if (
		target.nativePlatform.startsWith("win32-") &&
		path.extname(candidatePath).toLowerCase() !== ".exe"
	) {
		throw new Error("Windows Desktop candidate must preserve the .exe suffix");
	}
	const [sourceFile, candidateFile] = await Promise.all([
		hashStableRegularFile(sourcePath, "Desktop candidate clean source"),
		hashStableRegularFile(candidatePath, "Desktop patched candidate"),
	]);
	const sourceSha256 = sourceFile.sha256;
	const patchedSha256 = candidateFile.sha256;
	if (
		buildResult.fetchResult.version !== target.codeVersion ||
		buildResult.fetchResult.platform !== target.nativePlatform ||
		buildResult.fetchResult.checksum !== target.sha256 ||
		sourceFile.size !== target.size ||
		candidateFile.size !== target.size ||
		sourceSha256 !== target.sha256 ||
		patchedSha256 === target.sha256
	) {
		throw new Error(
			"Desktop candidate source or output byte identity mismatch",
		);
	}
	if (
		receipt.upstreamVersion !== target.codeVersion ||
		receipt.upstreamPlatform !== target.nativePlatform ||
		receipt.upstreamChecksum !== target.sha256 ||
		receipt.upstreamManifestChecksumVerified !== true ||
		receipt.upstreamManifestSignature !== "not-provided" ||
		receipt.cleanSha256 !== target.sha256 ||
		receipt.patchedSha256 !== patchedSha256 ||
		receipt.profile !== "desktop-local" ||
		receipt.binaryFormat !== target.binaryFormat ||
		receipt.structuralVerification !== "pass" ||
		receipt.signingPolicy !== "unconfigured" ||
		receipt.signingVerification !== "not-run" ||
		receipt.hostExecution !== "not-run"
	) {
		throw new Error("Desktop candidate artifact receipt is inconsistent");
	}
	assertJsonEqual(
		receipt.selectedTags,
		patchSelection.receipt.selectedTags,
		"Desktop candidate artifact roster",
	);
	const profile: DesktopCandidateProfileEvidence = {
		...patchSelection.receipt,
		exclusions: patchSelection.receipt.exclusions.map(
			(exclusion): PatchProfileExclusion => ({ ...exclusion }),
		),
		requiredProbes: [...patchSelection.receipt.requiredProbes],
		selectedTags: [...patchSelection.receipt.selectedTags],
		supportReadiness: "blocked",
		selectable: false,
		supportedClaims: 0,
	};
	const evidence: DesktopCandidateEvidence = {
		schemaVersion: DESKTOP_CANDIDATE_SCHEMA_VERSION,
		bindings: structuredClone(options.context.bindings),
		target: structuredClone(target),
		profile,
		candidate: {
			locatorId: `desktop-candidate:${target.desktopVersion}:${target.codeVersion}:${target.nativePlatform}:${patchedSha256.slice(0, 12)}`,
			source: "official-release-copy",
			cleanSha256: sourceSha256,
			patchedSha256,
			size: candidateFile.size,
			binaryFormat: receipt.binaryFormat,
			patchVerification: "pass",
			structuralVerification: "pass",
			patchReceipt: "verified",
			signingPolicy: "unconfigured",
			signingVerification: "not-run",
			hostExecution: "not-run",
			desktopLaunch: "not-run",
			surfaceCompatibility: "not-evaluated",
		},
		boundaries: {
			separateCandidateCopy: true,
			managedArtifactMutation: "not-authorized",
			signing: "not-authorized",
			activation: "not-authorized",
			desktopLaunch: "not-authorized",
			profilePromotion: "blocked",
			remoteControl: "closed",
			selfHosted: "closed",
		},
		createdAt: receipt.createdAt,
	};
	validateDesktopCandidateEvidence(evidence, options.context);
	return {
		candidatePath: candidatePathReal,
		fromCache: buildResult.fetchResult.fromCache,
		profile: patchSelection.receipt,
		artifactReceipt: rebindArtifactReceipt(receipt, target),
		evidence,
	};
}

export function validateDesktopCandidateEvidence(
	value: unknown,
	context?: DesktopCandidateContext,
): asserts value is DesktopCandidateEvidence {
	const evidence = requireObject(value, "Desktop candidate evidence");
	if (evidence.schemaVersion !== DESKTOP_CANDIDATE_SCHEMA_VERSION) {
		throw new Error("Unsupported Desktop candidate schemaVersion");
	}
	const bindings = requireObject(
		evidence.bindings,
		"Desktop candidate bindings",
	);
	for (const key of [
		"inventoryFileSha256",
		"artifactFileSha256",
		"sdkContractFileSha256",
		"probePlanFileSha256",
		"profileSupportFileSha256",
		"stockPreflightFileSha256",
		"stockBaselineFileSha256",
	] as const) {
		if (typeof bindings[key] !== "string" || !SHA256_RE.test(bindings[key])) {
			throw new Error(`Desktop candidate ${key} is invalid`);
		}
	}
	const canonicalChain = requireObject(
		bindings.canonicalChain,
		"Desktop candidate canonical chain",
	);
	if (
		Object.keys(canonicalChain).length !== 5 ||
		Object.values(canonicalChain).some(
			(digest) => typeof digest !== "string" || !SHA256_RE.test(digest),
		)
	) {
		throw new Error("Desktop candidate canonical chain is invalid");
	}
	const target = requireObject(evidence.target, "Desktop candidate target");
	if (
		typeof target.desktopLocatorId !== "string" ||
		typeof target.desktopVersion !== "string" ||
		!VERSION_RE.test(target.desktopVersion) ||
		typeof target.packagedAgentSdkVersion !== "string" ||
		!VERSION_RE.test(target.packagedAgentSdkVersion) ||
		typeof target.codeLocatorId !== "string" ||
		typeof target.codeVersion !== "string" ||
		!VERSION_RE.test(target.codeVersion) ||
		typeof target.nativePlatform !== "string" ||
		!isNativeArtifactPlatform(target.nativePlatform) ||
		typeof target.sha256 !== "string" ||
		!SHA256_RE.test(target.sha256) ||
		typeof target.size !== "number" ||
		!Number.isSafeInteger(target.size) ||
		target.size < 1 ||
		target.desktopLocatorId !== `desktop:${target.desktopVersion}` ||
		target.codeLocatorId !== `desktop-code:${target.codeVersion}`
	) {
		throw new Error("Desktop candidate target identity is invalid");
	}
	const expectedShape = expectedPlatformShape(target.nativePlatform);
	if (
		target.platform !== expectedShape.desktopPlatform ||
		target.binaryFormat !== expectedShape.binaryFormat ||
		target.architecture !== expectedShape.architecture
	) {
		throw new Error("Desktop candidate target classification is invalid");
	}
	const profile = requireObject(evidence.profile, "Desktop candidate profile");
	if (
		profile.name !== "desktop-local" ||
		profile.surface !== "desktop-local" ||
		profile.supportReadiness !== "blocked" ||
		profile.selectable !== false ||
		profile.supportedClaims !== 0
	) {
		throw new Error("Desktop candidate profile boundary is invalid");
	}
	assertJsonEqual(
		profile.selectedTags,
		DESKTOP_LOCAL_CANDIDATE_TAGS,
		"Desktop candidate selected tags",
	);
	assertJsonEqual(
		profile.exclusions,
		DESKTOP_LOCAL_EXCLUSIONS,
		"Desktop candidate exclusions",
	);
	assertJsonEqual(
		profile.requiredProbes,
		DESKTOP_LOCAL_REQUIRED_PROBES,
		"Desktop candidate required probes",
	);
	const candidate = requireObject(
		evidence.candidate,
		"Desktop candidate artifact",
	);
	if (
		typeof candidate.patchedSha256 !== "string" ||
		!SHA256_RE.test(candidate.patchedSha256) ||
		candidate.cleanSha256 !== target.sha256 ||
		candidate.patchedSha256 === target.sha256 ||
		candidate.size !== target.size ||
		candidate.binaryFormat !== target.binaryFormat ||
		candidate.source !== "official-release-copy" ||
		candidate.patchVerification !== "pass" ||
		candidate.structuralVerification !== "pass" ||
		candidate.patchReceipt !== "verified" ||
		candidate.signingPolicy !== "unconfigured" ||
		candidate.signingVerification !== "not-run" ||
		candidate.hostExecution !== "not-run" ||
		candidate.desktopLaunch !== "not-run" ||
		candidate.surfaceCompatibility !== "not-evaluated" ||
		candidate.locatorId !==
			`desktop-candidate:${target.desktopVersion}:${target.codeVersion}:${target.nativePlatform}:${candidate.patchedSha256.slice(0, 12)}`
	) {
		throw new Error("Desktop candidate artifact evidence is invalid");
	}
	const expectedBoundaries: DesktopCandidateEvidence["boundaries"] = {
		separateCandidateCopy: true,
		managedArtifactMutation: "not-authorized",
		signing: "not-authorized",
		activation: "not-authorized",
		desktopLaunch: "not-authorized",
		profilePromotion: "blocked",
		remoteControl: "closed",
		selfHosted: "closed",
	};
	assertJsonEqual(
		evidence.boundaries,
		expectedBoundaries,
		"Desktop candidate safety boundaries",
	);
	if (
		typeof evidence.createdAt !== "string" ||
		Number.isNaN(Date.parse(evidence.createdAt))
	) {
		throw new Error("Desktop candidate createdAt is invalid");
	}
	if (
		/[A-Z]:\\|\/home\/|\\Users\\|sessionId|credential|accessToken/i.test(
			JSON.stringify(evidence),
		)
	) {
		throw new Error("Desktop candidate evidence contains a prohibited value");
	}
	if (context) {
		assertJsonEqual(
			evidence.bindings,
			context.bindings,
			"Desktop candidate bindings",
		);
		assertJsonEqual(
			evidence.target,
			context.target,
			"Desktop candidate target",
		);
		assertProfileSupport(context);
	}
}
