import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	computeWorkflowReplayFingerprint,
	type WorkflowReplayName,
} from "./workflow-replay-fingerprint.js";

const sourceRepoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function makeGitFixture(root: string): Promise<string> {
	const repoRoot = path.join(root, "repo");
	await fs.mkdir(repoRoot, { recursive: true });
	execFileSync("git", ["init", "--quiet", repoRoot]);
	await fs.writeFile(
		path.join(repoRoot, ".gitignore"),
		"ignored.txt\nversions_clean/\n",
		"utf8",
	);
	await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n", "utf8");
	await fs.writeFile(path.join(repoRoot, "missing.txt"), "missing\n", "utf8");
	execFileSync("git", ["add", ".gitignore", "tracked.txt", "missing.txt"], {
		cwd: repoRoot,
	});
	await fs.unlink(path.join(repoRoot, "missing.txt"));
	await fs.writeFile(
		path.join(repoRoot, "untracked.txt"),
		"untracked\n",
		"utf8",
	);
	await fs.writeFile(path.join(repoRoot, "ignored.txt"), "ignored\n", "utf8");
	return repoRoot;
}

function commitFixture(repoRoot: string, message: string): void {
	execFileSync("git", ["commit", "--quiet", "-m", message], {
		cwd: repoRoot,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Synthetic Author",
			GIT_AUTHOR_EMAIL: "synthetic@example.test",
			GIT_COMMITTER_NAME: "Synthetic Committer",
			GIT_COMMITTER_EMAIL: "synthetic@example.test",
		},
	});
}

async function makeTempFixture(
	t: TestContext,
	prefix: string,
): Promise<{ tempDir: string; repoRoot: string; versionsDir: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	t.after(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});
	return {
		tempDir,
		repoRoot: await makeGitFixture(tempDir),
		versionsDir: path.join(tempDir, "state", "versions"),
	};
}

async function fingerprint(
	workflow: WorkflowReplayName,
	repoRoot: string,
	versionsDir: string,
	patchedExportPath?: string,
): Promise<string> {
	return computeWorkflowReplayFingerprint({
		workflow,
		repoRoot,
		versionsDir,
		patchedExportPath,
	});
}

test("base repository hashing is portable and excludes ignored files", async (t) => {
	const first = await makeTempFixture(t, "wf-state-first-");
	const second = await makeTempFixture(t, "wf-state-second-");

	const firstHash = await fingerprint(
		"patch-audit",
		first.repoRoot,
		first.versionsDir,
	);
	const secondHash = await fingerprint(
		"patch-audit",
		second.repoRoot,
		second.versionsDir,
	);
	assert.match(firstHash, /^wf-state-v1:[0-9a-f]{64}$/);
	assert.equal(firstHash, secondHash);

	await fs.writeFile(
		path.join(second.repoRoot, "ignored.txt"),
		"different ignored content\n",
		"utf8",
	);
	assert.equal(
		await fingerprint("patch-audit", second.repoRoot, second.versionsDir),
		firstHash,
	);
});

test("base repository hashing includes non-ignored untracked files", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-untracked-");
	const before = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.writeFile(
		path.join(fixture.repoRoot, "untracked.txt"),
		"changed untracked content\n",
		"utf8",
	);
	const after = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("base repository hashing distinguishes a missing tracked file", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-missing-");
	const missing = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.writeFile(
		path.join(fixture.repoRoot, "missing.txt"),
		"missing\n",
		"utf8",
	);
	const restored = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(restored, missing);
});

test("base repository hashing binds the Git index, HEAD, and executable state", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-git-");
	const trackedPath = path.join(fixture.repoRoot, "tracked.txt");
	await fs.writeFile(trackedPath, "staged content\n", "utf8");
	const unstaged = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	execFileSync("git", ["add", "tracked.txt"], { cwd: fixture.repoRoot });
	const staged = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(staged, unstaged);

	commitFixture(fixture.repoRoot, "fixture state");
	const committed = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(committed, staged);

	await fs.chmod(trackedPath, 0o755);
	const executable = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(executable, committed);
});

test("repository symlinks bind safe in-root target bytes and reject escapes", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-repo-link-");
	const internalLink = path.join(fixture.repoRoot, "ignored-link");
	await fs.symlink("ignored.txt", internalLink);
	execFileSync("git", ["add", "ignored-link"], { cwd: fixture.repoRoot });
	const before = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.writeFile(
		path.join(fixture.repoRoot, "ignored.txt"),
		"changed ignored target\n",
		"utf8",
	);
	const after = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);

	const externalPath = path.join(fixture.tempDir, "outside.txt");
	await fs.writeFile(externalPath, "outside\n", "utf8");
	await fs.symlink(externalPath, path.join(fixture.repoRoot, "escaping-link"));
	execFileSync("git", ["add", "escaping-link"], { cwd: fixture.repoRoot });
	await assert.rejects(
		fingerprint("patch-audit", fixture.repoRoot, fixture.versionsDir),
		/escapes the repository fingerprint root/,
	);
});

test("workflow name participates in the digest", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-workflow-");
	const audit = await fingerprint(
		"patch-audit",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	const update = await fingerprint(
		"patch-update",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(update, audit);
});

test("clean bundles affect audit, update, and triage fingerprints", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-clean-");
	const cliPath = path.join(
		fixture.repoRoot,
		"versions_clean",
		"1.2.3",
		"cli.js",
	);
	await fs.mkdir(path.dirname(cliPath), { recursive: true });
	await fs.writeFile(cliPath, "first clean bundle\n", "utf8");
	const workflows: WorkflowReplayName[] = [
		"patch-audit",
		"patch-update",
		"release-triage",
		"patch-smoke",
	];
	const before = new Map<string, string>();
	for (const workflow of workflows) {
		before.set(
			workflow,
			await fingerprint(workflow, fixture.repoRoot, fixture.versionsDir),
		);
	}

	await fs.writeFile(cliPath, "second clean bundle\n", "utf8");
	for (const workflow of workflows.slice(0, 3)) {
		assert.notEqual(
			await fingerprint(workflow, fixture.repoRoot, fixture.versionsDir),
			before.get(workflow),
		);
	}
	assert.equal(
		await fingerprint("patch-smoke", fixture.repoRoot, fixture.versionsDir),
		before.get("patch-smoke"),
	);
});

test("clean bundles fail closed when cli.js is a symlink", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-clean-link-");
	const externalCli = path.join(fixture.tempDir, "external-cli.js");
	const cliPath = path.join(
		fixture.repoRoot,
		"versions_clean",
		"1.2.3",
		"cli.js",
	);
	await fs.writeFile(externalCli, "external clean bundle\n", "utf8");
	await fs.mkdir(path.dirname(cliPath), { recursive: true });
	await fs.symlink(externalCli, cliPath);
	await assert.rejects(
		fingerprint("patch-audit", fixture.repoRoot, fixture.versionsDir),
		/clean bundle cli.js must be a regular file/,
	);
});

test("clean bundles fail closed when a version directory is a symlink", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-clean-dir-link-");
	const externalVersion = path.join(fixture.tempDir, "external-version");
	const cleanRoot = path.join(fixture.repoRoot, "versions_clean");
	await fs.mkdir(externalVersion, { recursive: true });
	await fs.mkdir(cleanRoot, { recursive: true });
	await fs.writeFile(
		path.join(externalVersion, "cli.js"),
		"external clean bundle\n",
		"utf8",
	);
	await fs.symlink(externalVersion, path.join(cleanRoot, "1.2.3"));
	await assert.rejects(
		fingerprint("patch-audit", fixture.repoRoot, fixture.versionsDir),
		/clean bundle version directory must be a regular directory/,
	);
});

test("clean bundles fail closed when the clean root is a symlink", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-clean-root-link-");
	const externalCleanRoot = path.join(fixture.tempDir, "external-clean");
	const externalCli = path.join(externalCleanRoot, "1.2.3", "cli.js");
	await fs.appendFile(
		path.join(fixture.repoRoot, ".gitignore"),
		"versions_clean\n",
		"utf8",
	);
	await fs.mkdir(path.dirname(externalCli), { recursive: true });
	await fs.writeFile(externalCli, "external clean bundle\n", "utf8");
	await fs.symlink(
		externalCleanRoot,
		path.join(fixture.repoRoot, "versions_clean"),
	);
	await assert.rejects(
		fingerprint("patch-audit", fixture.repoRoot, fixture.versionsDir),
		/clean bundle root must be a regular directory/,
	);
});

test("patch-update hashes a supplied export tree without absolute paths", async (t) => {
	const first = await makeTempFixture(t, "wf-state-export-first-");
	const second = await makeTempFixture(t, "wf-state-export-second-");
	const firstExport = path.join(first.tempDir, "export");
	const secondExport = path.join(second.tempDir, "elsewhere", "export");
	for (const exportPath of [firstExport, secondExport]) {
		await fs.mkdir(path.join(exportPath, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(exportPath, "agents", "plan.md"),
			"synthetic export\n",
			"utf8",
		);
	}

	const firstHash = await fingerprint(
		"patch-update",
		first.repoRoot,
		first.versionsDir,
		firstExport,
	);
	const secondHash = await fingerprint(
		"patch-update",
		second.repoRoot,
		second.versionsDir,
		secondExport,
	);
	assert.equal(firstHash, secondHash);

	await fs.writeFile(
		path.join(secondExport, "agents", "plan.md"),
		"changed synthetic export\n",
		"utf8",
	);
	assert.notEqual(
		await fingerprint(
			"patch-update",
			second.repoRoot,
			second.versionsDir,
			secondExport,
		),
		firstHash,
	);
});

test("patch-update export trees fail closed on symlinks", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-export-link-");
	const exportPath = path.join(fixture.tempDir, "export");
	const externalTree = path.join(fixture.tempDir, "external-tree");
	await fs.mkdir(exportPath, { recursive: true });
	await fs.mkdir(externalTree, { recursive: true });
	await fs.writeFile(path.join(externalTree, "plan.md"), "external\n", "utf8");
	await fs.symlink(externalTree, path.join(exportPath, "agents"));
	await assert.rejects(
		fingerprint(
			"patch-update",
			fixture.repoRoot,
			fixture.versionsDir,
			exportPath,
		),
		/patched export trees do not allow symbolic links/,
	);
});

interface SyntheticPatchMetadata {
	cacheKey: string;
	version: string;
	platform: string;
	cleanSha256: string;
	selectedTags: string[];
	patcherRevision: string;
	createdAt: string;
}

function patchMetadata(createdAt: string): SyntheticPatchMetadata {
	return {
		cacheKey: "synthetic-cache-key",
		version: "1.2.3",
		platform: "linux-x64",
		cleanSha256: "a".repeat(64),
		selectedTags: ["alpha", "beta"],
		patcherRevision: "synthetic-revision",
		createdAt,
	};
}

async function writePromotedState(
	versionsDir: string,
	currentContent: string,
	createdAt: string,
): Promise<{ currentBinary: string; previousBinary: string }> {
	const buildsDir = path.join(path.dirname(versionsDir), "cache", "builds");
	const currentBinary = path.join(buildsDir, "current-claude");
	const previousBinary = path.join(buildsDir, "previous-claude");
	await fs.mkdir(buildsDir, { recursive: true });
	await fs.mkdir(versionsDir, { recursive: true });
	await fs.writeFile(currentBinary, currentContent, "utf8");
	await fs.writeFile(previousBinary, "same previous binary\n", "utf8");
	await fs.writeFile(
		`${currentBinary}.patch-meta.json`,
		JSON.stringify(patchMetadata(createdAt)),
		"utf8",
	);
	await fs.writeFile(
		`${previousBinary}.patch-meta.json`,
		JSON.stringify(patchMetadata(createdAt)),
		"utf8",
	);
	await fs.symlink(currentBinary, path.join(versionsDir, "current"));
	await fs.symlink(previousBinary, path.join(versionsDir, "previous"));
	return { currentBinary, previousBinary };
}

test("patch-smoke ignores metadata timestamps while hashing promoted bytes", async (t) => {
	const first = await makeTempFixture(t, "wf-state-smoke-first-");
	const second = await makeTempFixture(t, "wf-state-smoke-second-");
	await writePromotedState(
		first.versionsDir,
		"same promoted binary\n",
		"2030-01-01T00:00:00.000Z",
	);
	await writePromotedState(
		second.versionsDir,
		"same promoted binary\n",
		"2040-01-01T00:00:00.000Z",
	);

	assert.equal(
		await fingerprint("patch-smoke", first.repoRoot, first.versionsDir),
		await fingerprint("patch-smoke", second.repoRoot, second.versionsDir),
	);
});

test("patch-smoke does not let valid metadata mask changed promoted bytes", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-smoke-valid-meta-");
	const { currentBinary } = await writePromotedState(
		fixture.versionsDir,
		"first promoted binary\n",
		"2030-01-01T00:00:00.000Z",
	);
	const before = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.writeFile(currentBinary, "changed promoted binary\n", "utf8");
	const after = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("patch-smoke hashes promoted binary content when metadata is invalid", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-smoke-fallback-");
	const { currentBinary } = await writePromotedState(
		fixture.versionsDir,
		"first promoted binary\n",
		"2030-01-01T00:00:00.000Z",
	);
	await fs.writeFile(`${currentBinary}.patch-meta.json`, "{invalid", "utf8");
	const before = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.writeFile(currentBinary, "changed promoted binary\n", "utf8");
	const after = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("patch-smoke includes current and previous link topology", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-smoke-links-");
	const { currentBinary } = await writePromotedState(
		fixture.versionsDir,
		"promoted binary\n",
		"2030-01-01T00:00:00.000Z",
	);
	const before = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.unlink(path.join(fixture.versionsDir, "previous"));
	await fs.symlink(currentBinary, path.join(fixture.versionsDir, "previous"));
	const after = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("patch-smoke distinguishes dangling destinations with the same basename", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-smoke-dangling-");
	await fs.mkdir(fixture.versionsDir, { recursive: true });
	const currentLink = path.join(fixture.versionsDir, "current");
	await fs.symlink(path.join(fixture.tempDir, "first", "missing"), currentLink);
	const before = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.unlink(currentLink);
	await fs.symlink(
		path.join(fixture.tempDir, "second", "missing"),
		currentLink,
	);
	const after = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("patch-smoke distinguishes non-file targets with the same basename", async (t) => {
	const fixture = await makeTempFixture(t, "wf-state-smoke-directory-");
	await fs.mkdir(fixture.versionsDir, { recursive: true });
	const firstTarget = path.join(fixture.tempDir, "first", "target");
	const secondTarget = path.join(fixture.tempDir, "second", "target");
	await fs.mkdir(firstTarget, { recursive: true });
	await fs.mkdir(secondTarget, { recursive: true });
	const currentLink = path.join(fixture.versionsDir, "current");
	await fs.symlink(firstTarget, currentLink);
	const before = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	await fs.unlink(currentLink);
	await fs.symlink(secondTarget, currentLink);
	const after = await fingerprint(
		"patch-smoke",
		fixture.repoRoot,
		fixture.versionsDir,
	);
	assert.notEqual(after, before);
});

test("workflow replay fingerprint CLI emits exactly one state token", {
	timeout: 30_000,
}, () => {
	const output = execFileSync(
		process.execPath,
		[
			path.join(sourceRepoRoot, "scripts", "workflow-replay-fingerprint.ts"),
			"patch-audit",
		],
		{ cwd: sourceRepoRoot, encoding: "utf8" },
	);
	assert.match(output, /^wf-state-v1:[0-9a-f]{64}\n$/);
});

test("workflow replay fingerprint CLI rejects state-root overrides", () => {
	const result = spawnSync(
		process.execPath,
		[
			path.join(sourceRepoRoot, "scripts", "workflow-replay-fingerprint.ts"),
			"patch-audit",
			"--repo-root",
			sourceRepoRoot,
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unknown arguments?: repo-root/);
});
