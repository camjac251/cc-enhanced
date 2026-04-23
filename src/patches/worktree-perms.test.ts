import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { worktreePerms } from "./worktree-perms.js";

async function applyWorktreePerms(source: string): Promise<string> {
	const ast = parse(source);
	const passes = (await worktreePerms.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: worktreePerms.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	assert.equal(worktreePerms.verify(output, ast), true);
	return output;
}

const WORKTREE_PERMS_FIXTURE = `
function spawnAgent(options, mode) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let worktree = null;
  if (mode === "worktree") {
    worktree = createWorktree();
  }
  return permissionContext;
}

function resumeAgent(options, mode, worktreePath) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let query = { worktreePath };
  return { permissionContext, query };
}
`;

const PARTIAL_WORKTREE_PERMS_FIXTURE = `
function spawnAgent(options, mode) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let worktree = null;
  if (mode === "worktree") {
    worktree = createWorktree();
  }
  if (worktree?.worktreePath) {
    permissionContext.additionalWorkingDirectories.set(worktree.worktreePath, "session");
  }
  return permissionContext;
}

function resumeAgent(options, mode, worktreePath) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let query = { worktreePath };
  return { permissionContext, query };
}
`;

const WRONG_GUARD_WORKTREE_PERMS_FIXTURE = `
function spawnAgent(options, mode) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let worktree = null;
  if (mode === "worktree") {
    worktree = createWorktree();
  }
  if (worktree) {
    permissionContext.additionalWorkingDirectories.set(worktree.worktreePath, "session");
  }
  return permissionContext;
}

function resumeAgent(options, mode, worktreePath) {
  let permissionContext = {
    ...options.toolPermissionContext,
    mode: mode ?? "acceptEdits"
  };
  let query = { worktreePath };
  if (query) {
    permissionContext.additionalWorkingDirectories.set(worktreePath, "session");
  }
  return { permissionContext, query };
}
`;

test("worktree-perms verify rejects unpatched permission contexts", () => {
	const ast = parse(WORKTREE_PERMS_FIXTURE);
	const result = worktreePerms.verify(WORKTREE_PERMS_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});

test("worktree-perms patches spawn and resume permission contexts", async () => {
	const output = await applyWorktreePerms(WORKTREE_PERMS_FIXTURE);

	assert.equal(
		output.includes(
			'permissionContext.additionalWorkingDirectories.set(worktree.worktreePath, "session")',
		),
		true,
	);
	assert.equal(
		output.includes(
			'permissionContext.additionalWorkingDirectories.set(worktreePath, "session")',
		),
		true,
	);
});

test("worktree-perms is idempotent", async () => {
	const firstPass = await applyWorktreePerms(WORKTREE_PERMS_FIXTURE);
	const secondPass = await applyWorktreePerms(firstPass);
	assert.equal(firstPass, secondPass);
});

test("worktree-perms verify rejects partial patches", () => {
	const ast = parse(PARTIAL_WORKTREE_PERMS_FIXTURE);
	const result = worktreePerms.verify(PARTIAL_WORKTREE_PERMS_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.match(String(result), /resume/);
});

test("worktree-perms verify rejects mismatched guards", () => {
	const ast = parse(WRONG_GUARD_WORKTREE_PERMS_FIXTURE);
	const result = worktreePerms.verify(WRONG_GUARD_WORKTREE_PERMS_FIXTURE, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
});
