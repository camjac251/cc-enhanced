import assert from "node:assert/strict";
import { test } from "node:test";
import * as t from "@babel/types";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { traverse } from "../babel.js";
import { parse, print } from "../loader.js";
import { disableAutoupdater } from "./no-autoupdate.js";

async function runDisableAutoupdaterViaPasses(ast: any): Promise<void> {
	const passes = (await disableAutoupdater.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: disableAutoupdater.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const AUTOUPDATER_FIXTURE = `
const envFlags = {};

function checkForUpdates() {
  if (envFlags.DISABLE_AUTOUPDATER) {
    return { type: "env", envVar: "DISABLE_AUTOUPDATER" };
  }
  return null;
}

function updatesDisabled() {
  return checkForUpdates() !== null;
}

function pluginAutoUpdate() {
  return updatesDisabled() && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;

test("no-autoupdate injects early return and plugin gate bypass", async () => {
	const ast = parse(AUTOUPDATER_FIXTURE);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);

	assert.equal(output.includes('return "patched";'), true);
	assert.equal(output.includes('checkForUpdates() === "patched"'), true);
	assert.equal(output.includes("return false;"), true);
	assert.equal(disableAutoupdater.verify(output, ast), true);
});

test("no-autoupdate is idempotent on already-patched code", async () => {
	const ast = parse(AUTOUPDATER_FIXTURE);
	await runDisableAutoupdaterViaPasses(ast);
	const firstPass = print(ast);

	const ast2 = parse(firstPass);
	await runDisableAutoupdaterViaPasses(ast2);
	const secondPass = print(ast2);

	assert.equal(firstPass, secondPass);
	assert.equal(disableAutoupdater.verify(secondPass, ast2), true);
});

test("verify rejects unpatched code", () => {
	const ast = parse(AUTOUPDATER_FIXTURE);
	const code = print(ast);
	const result = disableAutoupdater.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("no-autoupdate ignores a bare force-config read", async () => {
	const fixture = `
function coreGuard() {
  if (envFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
const envFlags = {};
function pluginForceGate() {
  return envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes('return "patched";'), true);
	assert.equal(output.includes('coreGuard() === "patched"'), false);
	assert.match(
		disableAutoupdater.verify(output, ast) as string,
		/exactly one plugin autoupdate gate function \(found 0\)/,
	);
});

test("no-autoupdate ignores a force-config disjunction", async () => {
	const fixture = `
function updatesDisabled() { return true; }
function coreGuard() {
  if (envFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
const envFlags = {};
function pluginForceGate() {
  return updatesDisabled() || !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes('return "patched";'), true);
	const result = disableAutoupdater.verify(output, ast);
	assert.notEqual(result, true);
	assert.match(result as string, /exactly one plugin autoupdate gate function/);
});

test("no-autoupdate ignores a force gate with an argument-taking check", async () => {
	const fixture = `
function updatesDisabled(mode) { return mode === "all"; }
function coreGuard() {
  if (envFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
const envFlags = {};
function pluginForceGate() {
  return updatesDisabled("all") && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes('return "patched";'), true);
	const result = disableAutoupdater.verify(output, ast);
	assert.notEqual(result, true);
	assert.match(result as string, /exactly one plugin autoupdate gate function/);
});

test("no-autoupdate targets exactly one guard fn and one plugin gate", async () => {
	const ast = parse(AUTOUPDATER_FIXTURE);
	await runDisableAutoupdaterViaPasses(ast);
	let guardFns = 0;
	let patchedGuardEntries = 0;
	let pluginGates = 0;
	traverse(ast, {
		Function(path) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;
			let hasDisable = false;
			path.traverse({
				IfStatement(p) {
					const test = p.node.test;
					if (
						t.isMemberExpression(test) &&
						t.isIdentifier(test.property, { name: "DISABLE_AUTOUPDATER" })
					)
						hasDisable = true;
				},
			});
			if (hasDisable) {
				guardFns++;
				const first = body.body[0];
				if (
					t.isReturnStatement(first) &&
					t.isStringLiteral(first.argument, { value: "patched" })
				)
					patchedGuardEntries++;
			}
			const hasForce = body.body.some((statement) => {
				if (!t.isReturnStatement(statement)) return false;
				if (!t.isLogicalExpression(statement.argument, { operator: "&&" }))
					return false;
				const { left, right } = statement.argument;
				return (
					t.isCallExpression(left) &&
					t.isIdentifier(left.callee) &&
					left.arguments.length === 0 &&
					t.isUnaryExpression(right, { operator: "!" }) &&
					t.isMemberExpression(right.argument) &&
					t.isIdentifier(right.argument.property, {
						name: "FORCE_AUTOUPDATE_PLUGINS",
					})
				);
			});
			if (hasForce) pluginGates++;
		},
	});
	assert.equal(guardFns, 1);
	assert.equal(patchedGuardEntries, 1);
	assert.equal(pluginGates, 1);
});

test("no-autoupdate verify rejects two plugin gate functions", async () => {
	const fixture = `
const envFlags = {};
function coreGuard() {
  if (envFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
function updatesDisabled() { return coreGuard() !== null; }
function pluginForceGateA() {
  return updatesDisabled() && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
function pluginForceGateB() {
  return updatesDisabled() && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);
	assert.match(
		disableAutoupdater.verify(output, ast) as string,
		/exactly one plugin autoupdate gate function \(found 2\)/,
	);
});

test("no-autoupdate verify rejects two distinct core-guard functions", async () => {
	const fixture = `
function coreGuardA() {
  if (envFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
function coreGuardB() {
  if (otherFlags.DISABLE_AUTOUPDATER) return "disabled";
  return null;
}
const envFlags = {};
const otherFlags = {};
function updatesDisabled() { return coreGuardA() !== null; }
function pluginForceGate() {
  return updatesDisabled() && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const output = print(ast);
	const result = disableAutoupdater.verify(output, ast);
	assert.notEqual(result, true);
	assert.equal(typeof result, "string");
	assert.match(result as string, /one auto-updater guard function name/);
});

test("no-autoupdate verify fails cleanly when the core-guard anchor is absent", async () => {
	const fixture = `
function someUnrelatedGuard() {
  if (envFlags.DISABLE_SOMETHING_ELSE) return "disabled";
  return null;
}
const envFlags = {};
function updatesDisabled() { return someUnrelatedGuard() !== null; }
function pluginForceGate() {
  return updatesDisabled() && !envFlags.FORCE_AUTOUPDATE_PLUGINS;
}
`;
	const ast = parse(fixture);
	await runDisableAutoupdaterViaPasses(ast);
	const result = disableAutoupdater.verify(print(ast), ast);
	assert.notEqual(result, true);
	assert.match(result as string, /guard function not found/);
});

test("no-autoupdate prepends the patched return ahead of the original guard if-test", async () => {
	const ast = parse(AUTOUPDATER_FIXTURE);
	await runDisableAutoupdaterViaPasses(ast);
	let checked = false;
	traverse(ast, {
		Function(path) {
			const body = path.node.body;
			if (!t.isBlockStatement(body)) return;
			let hasDisable = false;
			path.traverse({
				IfStatement(p) {
					if (
						t.isMemberExpression(p.node.test) &&
						t.isIdentifier(p.node.test.property, {
							name: "DISABLE_AUTOUPDATER",
						})
					)
						hasDisable = true;
				},
			});
			if (!hasDisable) return;
			checked = true;
			const first = body.body[0];
			assert.ok(
				t.isReturnStatement(first) &&
					t.isStringLiteral(first.argument, { value: "patched" }),
				"sentinel return must be the first statement of the guard fn",
			);
			assert.ok(
				t.isIfStatement(body.body[1]),
				"original guard if-test must remain immediately after the sentinel",
			);
		},
	});
	assert.equal(checked, true);
});
