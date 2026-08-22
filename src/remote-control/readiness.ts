import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type NativeHostReceipt,
	validateNativeHostReceipt,
} from "../artifacts/native-host-evidence.js";
import {
	createOperationResult,
	type OperationResult,
	type VerificationCheck,
} from "../operations/contract.js";
import type { PatchExclusionReason } from "../profiles/contract.js";
import {
	createPatchSurfaceReadiness,
	type PatchSupportSummary,
} from "../profiles/readiness.js";
import type { NativeArtifactPlatform } from "../targets/contract.js";

export const REMOTE_CONTROL_READINESS_SCHEMA_VERSION = 1 as const;

const MAX_SETTINGS_FILES = 8;
const MAX_SETTINGS_BYTES = 1024 * 1024;

const CONFIGURATION_CHECKS = [
	{ id: "auth-api-key", key: "ANTHROPIC_API_KEY" },
	{ id: "auth-token", key: "ANTHROPIC_AUTH_TOKEN" },
	{ id: "provider-bedrock", key: "CLAUDE_CODE_USE_BEDROCK" },
	{ id: "provider-vertex", key: "CLAUDE_CODE_USE_VERTEX" },
	{ id: "provider-foundry", key: "CLAUDE_CODE_USE_FOUNDRY" },
	{ id: "provider-gateway", key: "CLAUDE_CODE_USE_GATEWAY" },
	{ id: "custom-base-url", key: "ANTHROPIC_BASE_URL" },
	{ id: "feature-disable-telemetry", key: "DISABLE_TELEMETRY" },
	{ id: "feature-do-not-track", key: "DO_NOT_TRACK" },
	{
		id: "feature-disable-nonessential-traffic",
		key: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
	},
	{ id: "feature-disable-growthbook", key: "DISABLE_GROWTHBOOK" },
] as const;

export type RemoteControlConfigurationBlocker =
	| (typeof CONFIGURATION_CHECKS)[number]["id"]
	| "settings-disable-remote-control";

const CONFIGURATION_CHECK_IDS = [
	...CONFIGURATION_CHECKS.map(({ id }) => id),
	"settings-disable-remote-control",
] as const satisfies readonly RemoteControlConfigurationBlocker[];

export interface RemoteControlConfigurationInspection {
	status: "inspected";
	settingsFilesInspected: number;
	checks: Array<{
		id: RemoteControlConfigurationBlocker;
		status: "pass" | "blocked";
	}>;
	blockers: RemoteControlConfigurationBlocker[];
}

export interface RemoteControlConfigurationNotInspected {
	status: "not-inspected";
	settingsFilesInspected: 0;
	blockers: [];
}

export type RemoteControlConfigurationEvidence =
	| RemoteControlConfigurationInspection
	| RemoteControlConfigurationNotInspected;

export interface RemoteControlReadinessProfile {
	name: "remote-control";
	readiness: "blocked";
	selectable: false;
	supportSha256: string;
	summary: PatchSupportSummary;
	candidateTags: string[];
	exclusions: Array<{
		tag: string;
		reason: PatchExclusionReason;
	}>;
	requiredProbes: string[];
}

export interface RemoteControlHostNotProvided {
	receipt: "not-provided";
}

export interface RemoteControlVerifiedHost {
	receipt: "verified";
	receiptSha256: string;
	targetId: string;
	upstreamVersion: string;
	platform: NativeArtifactPlatform;
	profile: "remote-control";
	finalizedSha256: string;
	runtimeTags: string[];
}

export type RemoteControlHostBinding =
	| RemoteControlHostNotProvided
	| RemoteControlVerifiedHost;

export type RemoteControlSpawnMode = "same-dir" | "worktree" | "session";
export type RemoteControlSandboxMode = "enabled" | "disabled";

export interface RemoteControlServerChoice {
	spawn: RemoteControlSpawnMode;
	capacity: number | null;
	sandbox: RemoteControlSandboxMode;
	createSessionInDir: boolean;
}

export interface RemoteControlServerPlan extends RemoteControlServerChoice {
	selection: "recommended-not-confirmed" | "operator-confirmed";
	argv: string[];
}

export interface RemoteControlEligibility {
	subscription: "confirmed" | "unknown";
	organizationEnablement: "confirmed" | "not-required" | "unknown";
	workspaceTrust: "confirmed" | "unknown";
	workspaceKind: "git" | "non-git" | "unknown";
}

export type RemoteControlReadinessBlocker =
	| RemoteControlConfigurationBlocker
	| "configuration-not-inspected"
	| "host-receipt-not-provided"
	| "subscription-unknown"
	| "organization-policy-unknown"
	| "workspace-trust-unknown"
	| "workspace-kind-unknown"
	| "server-choice-not-confirmed";

export interface RemoteControlReadinessPlan {
	schemaVersion: typeof REMOTE_CONTROL_READINESS_SCHEMA_VERSION;
	kind: "plan";
	profile: RemoteControlReadinessProfile;
	host: RemoteControlHostBinding;
	environment: RemoteControlConfigurationEvidence;
	eligibility: RemoteControlEligibility;
	server: RemoteControlServerPlan;
	clients: {
		web: "not-run";
		mobile: "not-run";
		desktop: "not-run";
	};
	blockers: RemoteControlReadinessBlocker[];
	readyForProbeLaunch: boolean;
	readyForSupportedUse: false;
	launchPolicy: {
		transcriptStorage: "acknowledge-at-start";
		liveStart: "separate-explicit-action";
	};
	boundaries: {
		transport: "upstream-owned";
		network: "outbound-https-only";
		protocolInterception: "forbidden";
		sessionUrlPersistence: "forbidden";
		liveLaunch: "not-authorized";
		accountChanges: "not-authorized";
		desktopActivation: "closed";
		selfHostedExecution: "closed";
	};
}

export type RemoteControlReadinessEvidence = RemoteControlReadinessPlan;

export interface CreateRemoteControlReadinessPlanOptions {
	configuration?: RemoteControlConfigurationInspection;
	hostReceipt?: NativeHostReceipt;
	eligibility?: RemoteControlEligibility;
	server?: RemoteControlServerChoice;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Canonical JSON number is invalid");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("Canonical JSON contains an unsupported value");
}

function sha256(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex");
}

function assertSha256(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`);
	}
}

function assertExactKeys(
	value: unknown,
	expected: readonly string[],
	label: string,
): asserts value is JsonObject {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new Error(`${label} field shape is invalid`);
	}
}

function profileBinding(): RemoteControlReadinessProfile {
	const support = createPatchSurfaceReadiness("remote-control");
	if (
		support.readiness !== "blocked" ||
		support.selectable ||
		support.summary.supported !== 0 ||
		support.summary.probeRequired !== 31 ||
		support.summary.excluded !== 15 ||
		support.summary.notAssessed !== 0
	) {
		throw new Error(
			"Remote Control readiness policy requires explicit support requalification",
		);
	}
	return {
		name: "remote-control",
		readiness: "blocked",
		selectable: false,
		supportSha256: sha256(support),
		summary: { ...support.summary },
		candidateTags: [...support.candidateTags],
		exclusions: support.patches.flatMap((patch) =>
			patch.support === "excluded" && patch.exclusionReason
				? [{ tag: patch.tag, reason: patch.exclusionReason }]
				: [],
		),
		requiredProbes: support.requiredProbes.map(({ id }) => id),
	};
}

function expectedRuntimeTags(): string[] {
	return profileBinding().candidateTags.filter((tag) => tag !== "signature");
}

function bindHostReceipt(
	receipt: NativeHostReceipt,
): RemoteControlVerifiedHost {
	validateNativeHostReceipt(receipt);
	if (receipt.profile !== "remote-control") {
		throw new Error("Remote Control host receipt has the wrong profile");
	}
	if (!arraysEqual(receipt.runtimeTags, expectedRuntimeTags())) {
		throw new Error(
			"Remote Control host runtime roster does not match the candidate",
		);
	}
	return {
		receipt: "verified",
		receiptSha256: sha256(receipt),
		targetId: receipt.targetId,
		upstreamVersion: receipt.upstreamVersion,
		platform: receipt.platform,
		profile: "remote-control",
		finalizedSha256: receipt.finalizedSha256,
		runtimeTags: [...receipt.runtimeTags],
	};
}

function validateCapacity(
	spawn: RemoteControlSpawnMode,
	capacity: number | null,
): void {
	if (spawn === "session") {
		if (capacity !== null) {
			throw new Error("Remote Control session spawn cannot use capacity");
		}
		return;
	}
	if (
		!Number.isInteger(capacity) ||
		(capacity ?? 0) < 1 ||
		(capacity ?? 0) > 32
	) {
		throw new Error(
			"Remote Control capacity must be an integer from 1 through 32",
		);
	}
}

function serverArgv(choice: RemoteControlServerChoice): string[] {
	validateCapacity(choice.spawn, choice.capacity);
	const argv = ["<verified-binary>", "remote-control", "--spawn", choice.spawn];
	if (choice.capacity !== null) {
		argv.push("--capacity", String(choice.capacity));
	}
	argv.push(choice.sandbox === "enabled" ? "--sandbox" : "--no-sandbox");
	argv.push(
		choice.createSessionInDir
			? "--create-session-in-dir"
			: "--no-create-session-in-dir",
	);
	return argv;
}

function createServerPlan(
	choice: RemoteControlServerChoice | undefined,
): RemoteControlServerPlan {
	const normalized: RemoteControlServerChoice = choice
		? { ...choice }
		: {
				spawn: "worktree",
				capacity: 1,
				sandbox: "enabled",
				createSessionInDir: true,
			};
	if (
		normalized.spawn !== "same-dir" &&
		normalized.spawn !== "worktree" &&
		normalized.spawn !== "session"
	) {
		throw new Error("Remote Control spawn mode is invalid");
	}
	if (normalized.sandbox !== "enabled" && normalized.sandbox !== "disabled") {
		throw new Error("Remote Control sandbox choice is invalid");
	}
	if (typeof normalized.createSessionInDir !== "boolean") {
		throw new Error("Remote Control create-session choice is invalid");
	}
	return {
		...normalized,
		selection: choice ? "operator-confirmed" : "recommended-not-confirmed",
		argv: serverArgv(normalized),
	};
}

function defaultEligibility(): RemoteControlEligibility {
	return {
		subscription: "unknown",
		organizationEnablement: "unknown",
		workspaceTrust: "unknown",
		workspaceKind: "unknown",
	};
}

function collectReadinessBlockers(options: {
	environment: RemoteControlConfigurationEvidence;
	host: RemoteControlHostBinding;
	eligibility: RemoteControlEligibility;
	server: RemoteControlServerPlan;
}): RemoteControlReadinessBlocker[] {
	const blockers: RemoteControlReadinessBlocker[] = [];
	if (options.environment.status === "not-inspected") {
		blockers.push("configuration-not-inspected");
	} else {
		blockers.push(...options.environment.blockers);
	}
	if (options.host.receipt === "not-provided") {
		blockers.push("host-receipt-not-provided");
	}
	if (options.eligibility.subscription !== "confirmed") {
		blockers.push("subscription-unknown");
	}
	if (
		options.eligibility.organizationEnablement !== "confirmed" &&
		options.eligibility.organizationEnablement !== "not-required"
	) {
		blockers.push("organization-policy-unknown");
	}
	if (options.eligibility.workspaceTrust !== "confirmed") {
		blockers.push("workspace-trust-unknown");
	}
	if (options.eligibility.workspaceKind === "unknown") {
		blockers.push("workspace-kind-unknown");
	}
	if (options.server.selection !== "operator-confirmed") {
		blockers.push("server-choice-not-confirmed");
	}
	return blockers;
}

export function createRemoteControlReadinessPlan(
	options: CreateRemoteControlReadinessPlanOptions = {},
): RemoteControlReadinessPlan {
	const environment: RemoteControlConfigurationEvidence = options.configuration
		? validateConfigurationInspection(options.configuration)
		: {
				status: "not-inspected",
				settingsFilesInspected: 0,
				blockers: [],
			};
	const host: RemoteControlHostBinding = options.hostReceipt
		? bindHostReceipt(options.hostReceipt)
		: { receipt: "not-provided" };
	const eligibility = options.eligibility
		? validateEligibility(options.eligibility)
		: defaultEligibility();
	const server = createServerPlan(options.server);
	const blockers = collectReadinessBlockers({
		environment,
		host,
		eligibility,
		server,
	});

	return {
		schemaVersion: REMOTE_CONTROL_READINESS_SCHEMA_VERSION,
		kind: "plan",
		profile: profileBinding(),
		host,
		environment,
		eligibility,
		server,
		clients: {
			web: "not-run",
			mobile: "not-run",
			desktop: "not-run",
		},
		blockers,
		readyForProbeLaunch: blockers.length === 0,
		readyForSupportedUse: false,
		launchPolicy: {
			transcriptStorage: "acknowledge-at-start",
			liveStart: "separate-explicit-action",
		},
		boundaries: {
			transport: "upstream-owned",
			network: "outbound-https-only",
			protocolInterception: "forbidden",
			sessionUrlPersistence: "forbidden",
			liveLaunch: "not-authorized",
			accountChanges: "not-authorized",
			desktopActivation: "closed",
			selfHostedExecution: "closed",
		},
	};
}

function isConfiguredValue(value: unknown): boolean {
	return typeof value === "string"
		? value.trim().length > 0
		: value !== undefined && value !== null && value !== false;
}

function isOfficialAnthropicEndpoint(value: unknown): boolean {
	if (typeof value !== "string" || value.trim().length === 0) return false;
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "api.anthropic.com" &&
			parsed.port === "" &&
			(parsed.pathname === "" || parsed.pathname === "/") &&
			parsed.search === "" &&
			parsed.hash === "" &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
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

function parseJsonObject(input: Buffer, label: string): JsonObject {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8`, {
			cause: error,
		});
	}
	assertNoDuplicateJsonKeys(text, label);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${label} contains invalid JSON`, {
			cause: error,
		});
	}
	if (!isRecord(parsed)) {
		throw new Error(`${label} must contain an object`);
	}
	return parsed;
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

async function readStableJsonObject(
	filePath: string,
	label: string,
): Promise<JsonObject> {
	let pathBefore: Stats;
	try {
		pathBefore = await fs.lstat(filePath);
	} catch {
		throw new Error(`${label} could not be inspected`);
	}
	if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
		throw new Error(`${label} must be a real regular file`);
	}
	if (pathBefore.size < 2 || pathBefore.size > MAX_SETTINGS_BYTES) {
		throw new Error(`${label} size exceeds limit`);
	}
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(filePath, "r");
	} catch {
		throw new Error(`${label} could not be opened`);
	}
	try {
		const handleBefore = await handle.stat();
		if (!sameFileIdentity(pathBefore, handleBefore)) {
			throw new Error(`${label} changed before reading`);
		}
		const contents = await handle.readFile();
		let pathAfter: Stats;
		try {
			pathAfter = await fs.lstat(filePath);
		} catch {
			throw new Error(`${label} changed while reading`);
		}
		const handleAfter = await handle.stat();
		if (
			!sameFileIdentity(handleBefore, handleAfter) ||
			!sameFileIdentity(pathBefore, pathAfter)
		) {
			throw new Error(`${label} changed while reading`);
		}
		return parseJsonObject(contents, label);
	} finally {
		await handle.close();
	}
}

function blockerStatus(
	id: RemoteControlConfigurationBlocker,
	blocked: ReadonlySet<RemoteControlConfigurationBlocker>,
): "pass" | "blocked" {
	return blocked.has(id) ? "blocked" : "pass";
}

function settingEnvironment(settings: JsonObject): JsonObject {
	const value = settings.env;
	if (value === undefined) return {};
	if (!isRecord(value)) {
		throw new Error("Remote Control settings env must be an object");
	}
	return value;
}

export async function inspectRemoteControlConfiguration(options: {
	env: Readonly<Record<string, string | undefined>>;
	settingsFiles: readonly string[];
}): Promise<RemoteControlConfigurationInspection> {
	if (options.settingsFiles.length > MAX_SETTINGS_FILES) {
		throw new Error("Remote Control settings file count exceeds limit");
	}
	const canonicalPaths = options.settingsFiles.map((filePath) =>
		path.resolve(filePath),
	);
	if (new Set(canonicalPaths).size !== canonicalPaths.length) {
		throw new Error("Remote Control settings file list contains duplicates");
	}
	const settings: JsonObject[] = [];
	for (const filePath of options.settingsFiles) {
		settings.push(
			await readStableJsonObject(filePath, "Remote Control settings"),
		);
	}
	const settingEnvironments = settings.map(settingEnvironment);
	const blocked = new Set<RemoteControlConfigurationBlocker>();
	for (const check of CONFIGURATION_CHECKS) {
		const values = [
			options.env[check.key],
			...settingEnvironments.map((environment) => environment[check.key]),
		];
		const isBlocked =
			check.id === "custom-base-url"
				? values.some(
						(value) =>
							isConfiguredValue(value) && !isOfficialAnthropicEndpoint(value),
					)
				: values.some(isConfiguredValue);
		if (isBlocked) blocked.add(check.id);
	}
	if (settings.some((value) => value.disableRemoteControl === true)) {
		blocked.add("settings-disable-remote-control");
	}
	const checks = CONFIGURATION_CHECK_IDS.map((id) => ({
		id,
		status: blockerStatus(id, blocked),
	}));
	return validateConfigurationInspection({
		status: "inspected",
		settingsFilesInspected: settings.length,
		checks,
		blockers: checks
			.filter(({ status }) => status === "blocked")
			.map(({ id }) => id),
	});
}

export async function readRemoteControlHostReceipt(
	filePath: string,
): Promise<NativeHostReceipt> {
	const receipt = (await readStableJsonObject(
		filePath,
		"Remote Control host receipt",
	)) as unknown as NativeHostReceipt;
	validateNativeHostReceipt(receipt);
	return receipt;
}

function validateConfigurationInspection(
	value: RemoteControlConfigurationInspection,
): RemoteControlConfigurationInspection {
	assertExactKeys(
		value,
		["status", "settingsFilesInspected", "checks", "blockers"],
		"Remote Control configuration inspection",
	);
	if (
		value.status !== "inspected" ||
		!Number.isInteger(value.settingsFilesInspected) ||
		value.settingsFilesInspected < 0 ||
		value.settingsFilesInspected > MAX_SETTINGS_FILES ||
		!Array.isArray(value.checks) ||
		!Array.isArray(value.blockers)
	) {
		throw new Error("Remote Control configuration inspection is invalid");
	}
	const ids = value.checks.map((check) => {
		assertExactKeys(
			check,
			["id", "status"],
			"Remote Control configuration check",
		);
		if (
			typeof check.id !== "string" ||
			!CONFIGURATION_CHECK_IDS.includes(
				check.id as RemoteControlConfigurationBlocker,
			) ||
			(check.status !== "pass" && check.status !== "blocked")
		) {
			throw new Error("Remote Control configuration check is invalid");
		}
		return check.id;
	});
	if (!arraysEqual(ids, CONFIGURATION_CHECK_IDS)) {
		throw new Error("Remote Control configuration check roster is invalid");
	}
	const expectedBlockers = value.checks
		.filter(({ status }) => status === "blocked")
		.map(({ id }) => id);
	if (!arraysEqual(value.blockers, expectedBlockers)) {
		throw new Error("Remote Control configuration blockers are inconsistent");
	}
	return value;
}

function validateEligibility(
	value: RemoteControlEligibility,
): RemoteControlEligibility {
	assertExactKeys(
		value,
		[
			"subscription",
			"organizationEnablement",
			"workspaceTrust",
			"workspaceKind",
		],
		"Remote Control eligibility",
	);
	if (value.subscription !== "confirmed" && value.subscription !== "unknown") {
		throw new Error("Remote Control subscription eligibility is invalid");
	}
	if (
		value.organizationEnablement !== "confirmed" &&
		value.organizationEnablement !== "not-required" &&
		value.organizationEnablement !== "unknown"
	) {
		throw new Error("Remote Control organization eligibility is invalid");
	}
	if (
		value.workspaceTrust !== "confirmed" &&
		value.workspaceTrust !== "unknown"
	) {
		throw new Error("Remote Control workspace trust is invalid");
	}
	if (
		value.workspaceKind !== "git" &&
		value.workspaceKind !== "non-git" &&
		value.workspaceKind !== "unknown"
	) {
		throw new Error("Remote Control workspace kind is invalid");
	}
	return value;
}

function validateHostBinding(value: RemoteControlHostBinding): void {
	if (value.receipt === "not-provided") {
		assertExactKeys(value, ["receipt"], "Remote Control host binding");
		return;
	}
	assertExactKeys(
		value,
		[
			"receipt",
			"receiptSha256",
			"targetId",
			"upstreamVersion",
			"platform",
			"profile",
			"finalizedSha256",
			"runtimeTags",
		],
		"Remote Control host binding",
	);
	assertSha256(value.receiptSha256, "Remote Control host receipt hash");
	assertSha256(value.finalizedSha256, "Remote Control host artifact hash");
	if (
		value.profile !== "remote-control" ||
		value.targetId !==
			`standalone-cli:${value.platform}:${value.upstreamVersion}` ||
		!arraysEqual(value.runtimeTags, expectedRuntimeTags())
	) {
		throw new Error("Remote Control host binding is inconsistent");
	}
}

function validateServerPlan(value: RemoteControlServerPlan): void {
	assertExactKeys(
		value,
		["spawn", "capacity", "sandbox", "createSessionInDir", "selection", "argv"],
		"Remote Control server plan",
	);
	if (
		(value.selection !== "recommended-not-confirmed" &&
			value.selection !== "operator-confirmed") ||
		!Array.isArray(value.argv)
	) {
		throw new Error("Remote Control server plan is invalid");
	}
	const expected = createServerPlan(
		value.selection === "operator-confirmed"
			? {
					spawn: value.spawn,
					capacity: value.capacity,
					sandbox: value.sandbox,
					createSessionInDir: value.createSessionInDir,
				}
			: undefined,
	);
	if (JSON.stringify(value) !== JSON.stringify(expected)) {
		throw new Error("Remote Control server plan is inconsistent");
	}
}

export function validateRemoteControlReadinessEvidence(
	value: unknown,
): RemoteControlReadinessEvidence {
	assertExactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"profile",
			"host",
			"environment",
			"eligibility",
			"server",
			"clients",
			"blockers",
			"readyForProbeLaunch",
			"readyForSupportedUse",
			"launchPolicy",
			"boundaries",
		],
		"Remote Control readiness evidence",
	);
	if (value.schemaVersion !== REMOTE_CONTROL_READINESS_SCHEMA_VERSION) {
		throw new Error("Unsupported Remote Control readiness schemaVersion");
	}
	if (value.kind !== "plan") {
		throw new Error("Remote Control readiness evidence has an invalid kind");
	}
	if (JSON.stringify(value.profile) !== JSON.stringify(profileBinding())) {
		throw new Error("Remote Control readiness profile binding is invalid");
	}
	const environment = value.environment as RemoteControlConfigurationEvidence;
	if (isRecord(environment) && environment.status === "not-inspected") {
		assertExactKeys(
			environment,
			["status", "settingsFilesInspected", "blockers"],
			"Remote Control configuration plan",
		);
		if (
			environment.settingsFilesInspected !== 0 ||
			!Array.isArray(environment.blockers) ||
			environment.blockers.length !== 0
		) {
			throw new Error("Remote Control configuration plan is invalid");
		}
	} else {
		validateConfigurationInspection(
			environment as RemoteControlConfigurationInspection,
		);
	}
	const host = value.host as RemoteControlHostBinding;
	if (
		!isRecord(host) ||
		(host.receipt !== "not-provided" && host.receipt !== "verified")
	) {
		throw new Error("Remote Control host binding is invalid");
	}
	validateHostBinding(host);
	const eligibility = validateEligibility(
		value.eligibility as RemoteControlEligibility,
	);
	const server = value.server as RemoteControlServerPlan;
	validateServerPlan(server);
	const expected = createRemoteControlReadinessPlan({
		configuration: environment.status === "inspected" ? environment : undefined,
		eligibility,
		server:
			server.selection === "operator-confirmed"
				? {
						spawn: server.spawn,
						capacity: server.capacity,
						sandbox: server.sandbox,
						createSessionInDir: server.createSessionInDir,
					}
				: undefined,
	});
	expected.host = host;
	expected.blockers = collectReadinessBlockers({
		environment,
		host,
		eligibility,
		server,
	});
	expected.readyForProbeLaunch = expected.blockers.length === 0;
	if (JSON.stringify(value) !== JSON.stringify(expected)) {
		throw new Error(
			"Remote Control readiness plan does not match the deterministic policy",
		);
	}
	return value as unknown as RemoteControlReadinessPlan;
}

export function createRemoteControlReadinessResult(
	evidence: RemoteControlReadinessPlan,
): OperationResult<RemoteControlReadinessPlan> {
	validateRemoteControlReadinessEvidence(evidence);
	const configurationInspected = evidence.environment.status === "inspected";
	const checks: VerificationCheck[] = [
		{
			id: "configuration-inspected",
			status: configurationInspected ? "pass" : "fail",
		},
		{
			id: "configuration-blockers",
			status: !configurationInspected
				? "skipped"
				: evidence.environment.blockers.length === 0
					? "pass"
					: "fail",
		},
		{
			id: "host-receipt",
			status: evidence.host.receipt === "verified" ? "pass" : "fail",
		},
		{
			id: "subscription",
			status:
				evidence.eligibility.subscription === "confirmed" ? "pass" : "fail",
		},
		{
			id: "organization-policy",
			status:
				evidence.eligibility.organizationEnablement === "confirmed" ||
				evidence.eligibility.organizationEnablement === "not-required"
					? "pass"
					: "fail",
		},
		{
			id: "workspace-trust",
			status:
				evidence.eligibility.workspaceTrust === "confirmed" ? "pass" : "fail",
		},
		{
			id: "workspace-kind",
			status:
				evidence.eligibility.workspaceKind === "unknown" ? "fail" : "pass",
		},
		{
			id: "server-choice",
			status:
				evidence.server.selection === "operator-confirmed" ? "pass" : "fail",
		},
		{
			id: "probe-launch-readiness",
			status: evidence.readyForProbeLaunch ? "pass" : "fail",
		},
		{
			id: "profile-support",
			status: "skipped",
			detail: "Profile remains blocked, probe-required, and non-selectable",
		},
		{
			id: "client-web",
			status: "skipped",
			detail: "Web client evidence is not-run",
		},
		{
			id: "client-mobile",
			status: "skipped",
			detail: "Mobile client evidence is not-run",
		},
		{
			id: "client-desktop",
			status: "skipped",
			detail:
				"Desktop client evidence is not-run and steering is probe-required",
		},
		{
			id: "start-consent",
			status: "skipped",
			detail:
				"Live authorization and transcript acknowledgement are invocation-time only",
		},
	];
	return createOperationResult({
		operation: "remote-control-readiness",
		ok: evidence.readyForProbeLaunch,
		data: evidence,
		checks,
		warnings: [
			{
				code: "profile-probe-required",
				message:
					"Probe-launch readiness is not a patch-support or client-compatibility claim.",
			},
			{
				code: "live-start-separate",
				message:
					"A live start requires separate authorization and transcript-storage acknowledgement.",
			},
		],
	});
}
