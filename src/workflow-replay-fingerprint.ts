import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Dirent, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveVersionPaths } from "./version-paths.js";

export const WORKFLOW_REPLAY_FINGERPRINT_FORMAT = "wf-state-v1";

export const WORKFLOW_REPLAY_NAMES = [
	"patch-smoke",
	"release-triage",
	"patch-audit",
	"patch-update",
] as const;

export type WorkflowReplayName = (typeof WORKFLOW_REPLAY_NAMES)[number];

export interface WorkflowReplayFingerprintOptions {
	workflow: WorkflowReplayName;
	repoRoot: string;
	versionsCleanDir?: string;
	versionsDir?: string;
	patchedExportPath?: string;
}

interface FingerprintRecord {
	scope: string;
	path: string;
	kind: string;
	size?: number;
	digest?: string;
	value?: string;
}

interface FileDigest {
	size: number;
	digest: string;
}

interface LinkState {
	state:
		| "missing"
		| "not-symlink"
		| "dangling"
		| "target-not-file"
		| "resolved";
	resolvedPath?: string;
	targetIdentityDigest?: string;
}

interface StablePatchMetadata {
	cacheKey: string;
	version: string;
	platform: string;
	cleanSha256: string;
	selectedTags: string[];
	patcherRevision: string;
}

const CLEAN_BUNDLE_WORKFLOWS = new Set<WorkflowReplayName>([
	"release-triage",
	"patch-audit",
	"patch-update",
]);

function stableCompare(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeRelativePath(relativePath: string): string {
	const portable = relativePath.split(path.sep).join("/");
	const normalized = path.posix.normalize(portable);
	if (
		path.posix.isAbsolute(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("\0")
	) {
		throw new Error(`Path is outside its fingerprint root: ${relativePath}`);
	}
	return normalized === "" ? "." : normalized;
}

function updateFrame(hash: ReturnType<typeof createHash>, value: string): void {
	const bytes = Buffer.from(value, "utf8");
	hash.update(`${bytes.byteLength}:`);
	hash.update(bytes);
}

function digestText(value: string): FileDigest {
	const bytes = Buffer.from(value, "utf8");
	return {
		size: bytes.byteLength,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function digestFile(filePath: string): Promise<FileDigest> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(filePath)) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		hash.update(bytes);
	}
	return { size, digest: hash.digest("hex") };
}

function missingPathError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function unresolvableLinkError(error: unknown): boolean {
	return (
		missingPathError(error) ||
		(error instanceof Error && "code" in error && error.code === "ELOOP")
	);
}

async function describePath(
	scope: string,
	relativePath: string,
	filePath: string,
): Promise<FingerprintRecord> {
	const portablePath = normalizeRelativePath(relativePath);
	let stat: Stats;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (missingPathError(error)) {
			return { scope, path: portablePath, kind: "missing" };
		}
		throw error;
	}

	if (stat.isFile()) {
		return {
			scope,
			path: portablePath,
			kind: stat.mode & 0o111 ? "file-executable" : "file",
			...(await digestFile(filePath)),
		};
	}
	if (stat.isSymbolicLink()) {
		const target = await fs.readlink(filePath);
		return {
			scope,
			path: portablePath,
			kind: "symlink",
			...digestText(target),
		};
	}
	if (stat.isDirectory()) {
		return { scope, path: portablePath, kind: "directory" };
	}
	return { scope, path: portablePath, kind: "other" };
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
}

async function describeRepositoryPath(
	scope: string,
	relativePath: string,
	repoRoot: string,
): Promise<FingerprintRecord> {
	const portablePath = normalizeRelativePath(relativePath);
	const filePath = path.join(repoRoot, relativePath);
	let stat: Stats;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (missingPathError(error)) {
			return { scope, path: portablePath, kind: "missing" };
		}
		throw error;
	}
	if (!stat.isSymbolicLink()) {
		return describePath(scope, relativePath, filePath);
	}

	const rawTarget = await fs.readlink(filePath);
	const unresolvedTarget = path.isAbsolute(rawTarget)
		? path.normalize(rawTarget)
		: path.resolve(path.dirname(filePath), rawTarget);
	if (!pathIsWithin(repoRoot, unresolvedTarget)) {
		throw new Error(`${portablePath} escapes the repository fingerprint root`);
	}
	const targetIdentity = `${path.isAbsolute(rawTarget) ? "absolute" : "relative"}:${normalizeRelativePath(path.relative(repoRoot, unresolvedTarget))}`;

	let resolvedTarget: string;
	try {
		resolvedTarget = await fs.realpath(filePath);
	} catch (error) {
		if (missingPathError(error)) {
			return {
				scope,
				path: portablePath,
				kind: "symlink-dangling",
				...digestText(targetIdentity),
			};
		}
		throw error;
	}
	if (!pathIsWithin(repoRoot, resolvedTarget)) {
		throw new Error(`${portablePath} escapes the repository fingerprint root`);
	}
	const targetStat = await fs.stat(resolvedTarget);
	if (!targetStat.isFile()) {
		throw new Error(
			`${portablePath} must resolve to a regular file inside the repository`,
		);
	}
	const targetDigest = await digestFile(resolvedTarget);
	const hash = createHash("sha256");
	updateFrame(hash, targetIdentity);
	updateFrame(hash, String(targetDigest.size));
	updateFrame(hash, targetDigest.digest);
	return {
		scope,
		path: portablePath,
		kind: "symlink-file",
		size: Buffer.byteLength(rawTarget, "utf8") + targetDigest.size,
		digest: hash.digest("hex"),
	};
}

interface GitCommandResult {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
}

async function runGitCommand(
	repoRoot: string,
	args: string[],
): Promise<GitCommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", repoRoot, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code: code ?? -1,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
	});
}

function throwGitFailure(result: GitCommandResult): never {
	throw new Error(
		`Unable to enumerate repository state: ${result.stderr.toString("utf8").trim() || `git exited ${result.code}`}`,
	);
}

async function listGitPaths(
	repoRoot: string,
	args: string[],
): Promise<string[]> {
	const result = await runGitCommand(repoRoot, ["ls-files", "-z", ...args]);
	if (result.code !== 0) throwGitFailure(result);
	return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function collectGitIndexRecords(
	repoRoot: string,
): Promise<FingerprintRecord[]> {
	const result = await runGitCommand(repoRoot, [
		"ls-files",
		"--stage",
		"-z",
		"--",
	]);
	if (result.code !== 0) throwGitFailure(result);
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map((entry) => {
			const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry);
			if (!match) throw new Error("Unable to parse Git index state");
			const [, mode, objectId, stage, relativePath] = match;
			return {
				scope: "repository-index",
				path: normalizeRelativePath(relativePath),
				kind: `stage-${stage}`,
				value: `${mode}:${objectId}`,
			};
		});
}

async function collectGitHeadRecord(
	repoRoot: string,
): Promise<FingerprintRecord> {
	const result = await runGitCommand(repoRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		"HEAD",
	]);
	if (result.code === 1 && result.stdout.length === 0) {
		return {
			scope: "repository-head",
			path: ".",
			kind: "unborn",
		};
	}
	if (result.code !== 0) throwGitFailure(result);
	const objectId = result.stdout.toString("utf8").trim();
	if (!/^[0-9a-f]+$/.test(objectId)) {
		throw new Error("Unable to parse Git HEAD state");
	}
	return {
		scope: "repository-head",
		path: ".",
		kind: "commit",
		value: objectId,
	};
}

async function collectRepositoryRecords(
	repoRoot: string,
): Promise<FingerprintRecord[]> {
	const [tracked, untracked, indexRecords, headRecord] = await Promise.all([
		listGitPaths(repoRoot, ["--cached", "--"]),
		listGitPaths(repoRoot, ["--others", "--exclude-standard", "--"]),
		collectGitIndexRecords(repoRoot),
		collectGitHeadRecord(repoRoot),
	]);
	const records: FingerprintRecord[] = [headRecord, ...indexRecords];
	for (const relativePath of tracked.sort(stableCompare)) {
		records.push(
			await describeRepositoryPath(
				"repository-tracked",
				relativePath,
				repoRoot,
			),
		);
	}
	for (const relativePath of untracked.sort(stableCompare)) {
		records.push(
			await describeRepositoryPath(
				"repository-untracked",
				relativePath,
				repoRoot,
			),
		);
	}
	return records;
}

async function collectCleanBundleRecords(
	versionsCleanDir: string,
): Promise<FingerprintRecord[]> {
	let rootStat: Stats;
	try {
		rootStat = await fs.lstat(versionsCleanDir);
	} catch (error) {
		if (missingPathError(error)) return [];
		throw error;
	}
	if (!rootStat.isDirectory()) {
		throw new Error("clean bundle root must be a regular directory");
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(versionsCleanDir, { withFileTypes: true });
	} catch (error) {
		if (missingPathError(error)) return [];
		throw error;
	}
	const versionNames: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error(
				`clean bundle version directory must be a regular directory: ${entry.name}`,
			);
		}
		if (entry.isDirectory()) versionNames.push(entry.name);
	}
	versionNames.sort(stableCompare);
	const records: FingerprintRecord[] = [];
	for (const versionName of versionNames) {
		const cliPath = path.join(versionsCleanDir, versionName, "cli.js");
		try {
			const stat = await fs.lstat(cliPath);
			if (!stat.isFile()) {
				throw new Error(
					`clean bundle cli.js must be a regular file: ${versionName}/cli.js`,
				);
			}
		} catch (error) {
			if (missingPathError(error)) continue;
			throw error;
		}
		records.push(
			await describePath("clean-bundle", `${versionName}/cli.js`, cliPath),
		);
	}
	return records;
}

async function collectTreeRecords(
	rootPath: string,
	scope: string,
): Promise<FingerprintRecord[]> {
	const records: FingerprintRecord[] = [];
	const visit = async (relativePath: string): Promise<void> => {
		const fullPath =
			relativePath === "." ? rootPath : path.join(rootPath, relativePath);
		const record = await describePath(scope, relativePath, fullPath);
		if (record.kind === "symlink") {
			throw new Error("patched export trees do not allow symbolic links");
		}
		records.push(record);
		if (record.kind !== "directory") return;
		const entries = (await fs.readdir(fullPath, { withFileTypes: true }))
			.map((entry) => entry.name)
			.sort(stableCompare);
		for (const entryName of entries) {
			const childPath =
				relativePath === "."
					? entryName
					: path.posix.join(normalizeRelativePath(relativePath), entryName);
			await visit(childPath);
		}
	};
	await visit(".");
	return records;
}

async function inspectLink(
	linkPath: string,
	identityRoot: string,
): Promise<LinkState> {
	let linkStat: Stats;
	try {
		linkStat = await fs.lstat(linkPath);
	} catch (error) {
		if (missingPathError(error)) return { state: "missing" };
		throw error;
	}
	if (!linkStat.isSymbolicLink()) {
		return {
			state: "not-symlink",
			...(linkStat.isFile() ? { resolvedPath: linkPath } : {}),
		};
	}

	const rawTarget = await fs.readlink(linkPath);
	const unresolvedTarget = path.isAbsolute(rawTarget)
		? path.normalize(rawTarget)
		: path.resolve(path.dirname(linkPath), rawTarget);
	const relativeTarget = path
		.relative(identityRoot, unresolvedTarget)
		.split(path.sep)
		.join("/");
	const targetIdentity = `${path.isAbsolute(rawTarget) ? "absolute" : "relative"}:${relativeTarget || "."}`;
	const targetIdentityDigest = digestText(targetIdentity).digest;

	let resolvedPath: string;
	try {
		resolvedPath = await fs.realpath(linkPath);
	} catch (error) {
		if (unresolvableLinkError(error)) {
			return { state: "dangling", targetIdentityDigest };
		}
		throw error;
	}
	const targetStat = await fs.stat(resolvedPath);
	if (!targetStat.isFile()) {
		return { state: "target-not-file", targetIdentityDigest };
	}
	return { state: "resolved", resolvedPath, targetIdentityDigest };
}

function parsePatchMetadata(value: unknown): StablePatchMetadata | null {
	if (!value || typeof value !== "object") return null;
	const metadata = value as Record<string, unknown>;
	if (
		typeof metadata.cacheKey !== "string" ||
		typeof metadata.version !== "string" ||
		typeof metadata.platform !== "string" ||
		typeof metadata.cleanSha256 !== "string" ||
		!Array.isArray(metadata.selectedTags) ||
		!metadata.selectedTags.every((tag) => typeof tag === "string") ||
		typeof metadata.patcherRevision !== "string" ||
		typeof metadata.createdAt !== "string"
	) {
		return null;
	}
	return {
		cacheKey: metadata.cacheKey,
		version: metadata.version,
		platform: metadata.platform,
		cleanSha256: metadata.cleanSha256,
		selectedTags: [...metadata.selectedTags].sort(stableCompare),
		patcherRevision: metadata.patcherRevision,
	};
}

async function readStablePatchMetadata(
	binaryPath: string,
): Promise<
	| { state: "valid"; metadata: StablePatchMetadata }
	| { state: "missing" | "invalid" }
> {
	let raw: string;
	try {
		raw = await fs.readFile(`${binaryPath}.patch-meta.json`, "utf8");
	} catch (error) {
		if (missingPathError(error)) return { state: "missing" };
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read patched-build metadata: ${reason}`, {
			cause: error,
		});
	}
	try {
		const metadata = parsePatchMetadata(JSON.parse(raw) as unknown);
		return metadata ? { state: "valid", metadata } : { state: "invalid" };
	} catch {
		return { state: "invalid" };
	}
}

async function describePromotedArtifact(
	pathName: "current" | "previous",
	binaryPath: string,
): Promise<FingerprintRecord[]> {
	const metadata = await readStablePatchMetadata(binaryPath);
	const records: FingerprintRecord[] = [
		{
			scope: "promoted-artifact",
			path: `${pathName}/binary`,
			kind: "file",
			...(await digestFile(binaryPath)),
		},
	];
	if (metadata.state === "valid") {
		const canonical = JSON.stringify(metadata.metadata);
		records.push({
			scope: "promoted-metadata",
			path: pathName,
			kind: "patch-metadata",
			...digestText(canonical),
		});
	} else {
		records.push({
			scope: "promoted-metadata",
			path: pathName,
			kind: metadata.state,
		});
	}
	return records;
}

async function collectPatchSmokeRecords(
	versionsDir: string,
): Promise<FingerprintRecord[]> {
	const identityRoot = path.dirname(versionsDir);
	const current = await inspectLink(
		path.join(versionsDir, "current"),
		identityRoot,
	);
	const previous = await inspectLink(
		path.join(versionsDir, "previous"),
		identityRoot,
	);
	const sameTarget =
		current.state === "resolved" &&
		previous.state === "resolved" &&
		current.resolvedPath === previous.resolvedPath;
	const records: FingerprintRecord[] = [
		{
			scope: "promotion-topology",
			path: "current",
			kind: current.state,
			digest: current.targetIdentityDigest,
			value: current.state === "resolved" ? "promoted-target" : undefined,
		},
		{
			scope: "promotion-topology",
			path: "previous",
			kind: previous.state,
			digest: previous.targetIdentityDigest,
			value:
				previous.state === "resolved"
					? sameTarget
						? "same-as-current"
						: "distinct-from-current"
					: undefined,
		},
	];
	if (current.resolvedPath) {
		records.push(
			...(await describePromotedArtifact("current", current.resolvedPath)),
		);
	}
	if (previous.resolvedPath && !sameTarget) {
		records.push(
			...(await describePromotedArtifact("previous", previous.resolvedPath)),
		);
	}
	return records;
}

function recordCompare(
	left: FingerprintRecord,
	right: FingerprintRecord,
): number {
	for (const key of ["scope", "path", "kind"] as const) {
		const comparison = stableCompare(left[key], right[key]);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

function finalizeFingerprint(
	workflow: WorkflowReplayName,
	records: FingerprintRecord[],
): string {
	const hash = createHash("sha256");
	updateFrame(hash, "workflow-replay-fingerprint");
	updateFrame(hash, WORKFLOW_REPLAY_FINGERPRINT_FORMAT);
	updateFrame(hash, workflow);
	const sortedRecords = records.sort(recordCompare);
	updateFrame(hash, String(sortedRecords.length));
	for (const record of sortedRecords) {
		updateFrame(hash, record.scope);
		updateFrame(hash, record.path);
		updateFrame(hash, record.kind);
		updateFrame(hash, record.size === undefined ? "" : String(record.size));
		updateFrame(hash, record.digest ?? "");
		updateFrame(hash, record.value ?? "");
	}
	return `${WORKFLOW_REPLAY_FINGERPRINT_FORMAT}:${hash.digest("hex")}`;
}

export async function computeWorkflowReplayFingerprint(
	options: WorkflowReplayFingerprintOptions,
): Promise<string> {
	if (!WORKFLOW_REPLAY_NAMES.includes(options.workflow)) {
		throw new Error(`Unsupported workflow: ${options.workflow}`);
	}
	if (options.patchedExportPath && options.workflow !== "patch-update") {
		throw new Error("patchedExportPath is only supported for patch-update");
	}

	const repoRoot = path.resolve(options.repoRoot);
	const records = await collectRepositoryRecords(repoRoot);
	if (CLEAN_BUNDLE_WORKFLOWS.has(options.workflow)) {
		records.push(
			...(await collectCleanBundleRecords(
				path.resolve(
					options.versionsCleanDir ?? path.join(repoRoot, "versions_clean"),
				),
			)),
		);
	}
	if (options.workflow === "patch-update" && options.patchedExportPath) {
		records.push(
			...(await collectTreeRecords(
				path.resolve(options.patchedExportPath),
				"patched-export",
			)),
		);
	}
	if (options.workflow === "patch-smoke") {
		const versionsDir = path.resolve(
			options.versionsDir ?? resolveVersionPaths().versionsDir,
		);
		records.push(...(await collectPatchSmokeRecords(versionsDir)));
	}
	return finalizeFingerprint(options.workflow, records);
}
