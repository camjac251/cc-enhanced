import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { skillGlobalPaths } from "./skill-global-paths.js";

async function runViaPasses(ast: any): Promise<void> {
	const passes = (await skillGlobalPaths.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: skillGlobalPaths.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

// Synthetic fixture mirroring the two upstream shapes the patch anchors on:
//   - a skill-dir loader that builds a skill object via a factory call whose
//     argument carries `loadedFrom: "skills"` and `paths: <id>`, where the id
//     binds to a paths-extractor call taking the frontmatter as first arg;
//   - a conditional-skill activation loop that builds a gitignore matcher from
//     a normalized `<skill>.paths` (wrapped in a validator call), skips
//     out-of-cwd files, and activates on `ignores(f)`.
// Names are semantic so the fixture does not double as an upstream-naming hint.
const FIXTURE = `
function loadSkill(w, name) {
  let X = parseFields(w);
  let L = extractPaths(w);
  return makeSkill({
    ...X,
    skillName: name,
    markdownContent: md,
    source: src,
    baseDir: bd,
    loadedFrom: "skills",
    paths: L,
  });
}

function activate(H, $) {
  let q = [];
  for (let [K, _] of state().conditionalSkills) {
    if (_.type !== "prompt" || !_.paths || _.paths.length === 0) continue;
    let A = ig.default().add(normalizeGlobs(_.paths, "skill_paths"));
    for (let z of H) {
      let f = pathmod.isAbsolute(z) ? pathmod.relative($, z) : z;
      if (!f || f.startsWith("..") || pathmod.isAbsolute(f)) continue;
      if (A.ignores(f)) {
        state().dynamicSkills.set(K, _),
          state().conditionalSkills.delete(K),
          state().activatedConditionalSkillNames.add(K),
          q.push(K),
          log("activated " + f);
        break;
      }
    }
  }
  return q;
}
`;

function extractFunction(src: string, name: string): string {
	const start = src.indexOf(`function ${name}`);
	if (start === -1) throw new Error(`function ${name} not found in output`);
	const open = src.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced braces extracting ${name}`);
}

function evalHelper(src: string, name: string): (...args: any[]) => any {
	const body = extractFunction(src, name);
	return new Function(`${body}\nreturn ${name};`)();
}

const SENTINEL = String.fromCharCode(57344);

test("skill-global-paths tag matches registration name", () => {
	assert.equal(skillGlobalPaths.tag, "skill-global-paths");
});

test("verify rejects unpatched code", () => {
	const ast = parse(FIXTURE);
	const result = skillGlobalPaths.verify(print(ast), ast);
	assert.equal(typeof result, "string");
});

test("patch wraps loader paths, splits matcher, injects helpers, and verifies", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);

	// Helpers injected.
	assert.ok(output.includes("function _claudePatchMergeGlobalPaths"));
	assert.ok(output.includes("function _claudePatchSplitPaths"));
	// Loader paths value wrapped with merge helper, frontmatter resolved to `w`.
	assert.ok(output.includes("_claudePatchMergeGlobalPaths(L, w)"));
	// Activation matcher split: cwd matcher normalizes local entries, global
	// matcher normalizes the sentinel (global) entries, split call present.
	assert.ok(output.includes("_claudePatchSplitPaths(_.paths)"));
	assert.ok(output.includes("normalizeGlobs(_claudeGpSplit.local"));
	assert.ok(output.includes("normalizeGlobs(_claudeGpSplit.global"));
	assert.ok(output.includes("_claudeGpIgnore"));

	assert.doesNotThrow(() => parse(output));
	assert.equal(skillGlobalPaths.verify(output, ast), true);
});

test("does not wrap object literals that are not skill-dir loaders", async () => {
	const ast = parse(`
function other() {
  return build({ loadedFrom: "plugin", paths: L });
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("_claudePatchMergeGlobalPaths("), false);
});

test("does not patch loops that are not the conditional-skill matcher", async () => {
	const ast = parse(`
function unrelated(H) {
  for (let [K, _] of other().somethingElse) {
    let A = ig.default().add(_.paths);
    for (let z of H) if (A.ignores(z)) return K;
  }
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	assert.equal(output.includes("_claudePatchSplitPaths("), false);
});

test("merge helper: no global-paths leaves local paths unchanged", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const merge = evalHelper(print(ast), "_claudePatchMergeGlobalPaths");

	assert.deepEqual(merge(["**/*.md"], {}), ["**/*.md"]);
	assert.deepEqual(merge(["**/*.md"], { "global-paths": null }), ["**/*.md"]);
	assert.equal(merge(undefined, {}), undefined);
});

test("merge helper: normalizes global entries (~ expand, / strip, ! and /** preserved)", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const merge = evalHelper(print(ast), "_claudePatchMergeGlobalPaths");

	const home = process.env.HOME || process.env.USERPROFILE || "";
	const out = merge(["**/*.md"], {
		"global-paths": [
			"**/CLAUDE.md",
			"!**/node_modules/**",
			"~/.claude/skills/**",
			"/etc/claude-code/**",
		],
	});

	assert.equal(out[0], "**/*.md");
	// floating pattern kept as-is behind the sentinel
	assert.equal(out[1], `${SENTINEL}**/CLAUDE.md`);
	// negation preserved, trailing /** NOT stripped
	assert.equal(out[2], `${SENTINEL}!**/node_modules/**`);
	// ~ expanded to home, leading slash stripped
	assert.equal(
		out[3],
		SENTINEL + `${home}/.claude/skills/**`.replace(/^\/+/, ""),
	);
	// absolute kept, leading slash stripped
	assert.equal(out[4], `${SENTINEL}etc/claude-code/**`);
});

test("split helper: partitions sentinel (global) from local and strips marker", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	const merge = evalHelper(output, "_claudePatchMergeGlobalPaths");
	const split = evalHelper(output, "_claudePatchSplitPaths");

	const merged = merge(["**/*.tsx"], {
		"global-paths": ["**/CLAUDE.md", "!**/node_modules/**"],
	});
	const { local, global } = split(merged);

	assert.deepEqual(local, ["**/*.tsx"]);
	assert.deepEqual(global, ["**/CLAUDE.md", "!**/node_modules/**"]);
});

test("global-only skill (no local paths) still produces a non-empty paths array", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const merge = evalHelper(print(ast), "_claudePatchMergeGlobalPaths");

	const out = merge(undefined, { "global-paths": ["**/SKILL.md"] });
	assert.ok(Array.isArray(out));
	assert.equal(out.length, 1);
	assert.equal(out[0], `${SENTINEL}**/SKILL.md`);
});

test("global-path check is injected before the cwd-skip guard", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	const idxGlobal = output.indexOf("_claudeGpIgnore.ignores");
	const idxSkip = output.indexOf('startsWith("..")');
	assert.notEqual(
		idxGlobal,
		-1,
		"global-path ignores() check must be injected",
	);
	assert.notEqual(idxSkip, -1, "cwd-skip guard must still be present");
	assert.ok(
		idxGlobal < idxSkip,
		"global-path check must run before the cwd-skip guard",
	);
});

test("global matcher tests the slash-stripped raw loop path", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	assert.ok(
		/_claudeGpIgnore\.ignores\(\s*z\.replace\(\s*\/\^\\\/\+\/\s*,\s*""\s*\)\s*\)/.test(
			output,
		),
		"global ignores() must receive the raw loop var stripped of leading slashes",
	);
});

test("wraps only the identifier-paths skills loader, not a void-paths sibling", async () => {
	const ast = parse(`
function loadA(w, name) {
  let L = extractPaths(w);
  return makeSkill({ skillName: name, loadedFrom: "skills", paths: L });
}
function loadB() {
  return makeSkill({ skillName: "x", loadedFrom: "skills", paths: void 0 });
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	// Count only wrap call sites (`paths: <merge>(...)`), not the injected helper
	// declaration which also contains the helper name.
	const wraps = output.match(/paths: _claudePatchMergeGlobalPaths\(/g) ?? [];
	assert.equal(
		wraps.length,
		1,
		"exactly one loader paths value should be wrapped",
	);
	assert.ok(output.includes("_claudePatchMergeGlobalPaths(L, w)"));
	// The sibling whose paths value is not an identifier is left untouched.
	assert.ok(output.includes("paths: void 0"));
});

test("merge helper returns undefined when all entries filter out", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const merge = evalHelper(print(ast), "_claudePatchMergeGlobalPaths");
	assert.equal(
		merge(undefined, { "global-paths": ["   ", "", "!"] }),
		undefined,
	);
	assert.equal(merge([], { "global-paths": [] }), undefined);
});

test("global matcher is conditional and the inner check is null-guarded", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	assert.ok(
		/_claudeGpSplit\.global\.length\s*>\s*0\s*\?/.test(output),
		"global matcher must be built only when split.global is non-empty",
	);
	assert.ok(
		/if\s*\(\s*_claudeGpIgnore\s*&&\s*_claudeGpIgnore\.ignores/.test(output),
		"inner global check must be guarded by a truthiness test on _claudeGpIgnore",
	);
});

test("activation matcher is split exactly once", async () => {
	const ast = parse(FIXTURE);
	await runViaPasses(ast);
	const output = print(ast);
	const splitCalls = output.match(/_claudePatchSplitPaths\(_\.paths\)/g) ?? [];
	assert.equal(splitCalls.length, 1, "matcher should be split exactly once");
});

test("wraps the identifier-paths loader even when a void-paths sibling comes first", async () => {
	const ast = parse(`
function loadB() {
  return makeSkill({ skillName: "x", loadedFrom: "skills", paths: void 0 });
}
function loadA(w, name) {
  let L = extractPaths(w);
  return makeSkill({ skillName: name, loadedFrom: "skills", paths: L });
}
`);
	await runViaPasses(ast);
	const output = print(ast);
	const wraps = output.match(/paths: _claudePatchMergeGlobalPaths\(/g) ?? [];
	assert.equal(
		wraps.length,
		1,
		"exactly the identifier-paths loader is wrapped",
	);
	assert.ok(output.includes("_claudePatchMergeGlobalPaths(L, w)"));
	assert.ok(output.includes("paths: void 0"));
});
