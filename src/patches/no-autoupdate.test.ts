import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
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
function isBool(v) { return typeof v === "boolean"; }

function checkForUpdates() {
  if (isBool(process.env.DISABLE_AUTOUPDATER)) {
    return "disabled";
  }
  return null;
}

function pluginAutoUpdate() {
  var force = isBool(process.env.FORCE_AUTOUPDATE_PLUGINS);
  if (force) return true;
  return false;
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
