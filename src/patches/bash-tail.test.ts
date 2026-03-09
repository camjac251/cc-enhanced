import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { bashOutputTail } from "./bash-tail.js";

async function runBashTailViaPasses(ast: any): Promise<void> {
	const passes = (await bashOutputTail.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: bashOutputTail.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const BASH_TAIL_FIXTURE = `
const tool = {
  name: "Bash",
  mapToolResultToToolResultBlockParam({ stdout, stderr, interrupted, isImageOutput, metadata }) {
    let unrelated = helper(alpha, beta);
    let payload = Y6A(stdout, limitChars);
    return {
      preview: payload.preview,
      hasMore: payload.hasMore,
      unrelated,
      stderr,
      interrupted,
      isImageOutput,
      metadata,
    };
  },
};
`;

test("verify rejects unpatched code", () => {
	const ast = parse(BASH_TAIL_FIXTURE);
	const code = print(ast);
	const result = bashOutputTail.verify(code, ast);
	assert.notEqual(
		result,
		true,
		"verify should reject unpatched code but got true",
	);
	assert.equal(typeof result, "string");
});

test("bash-tail rewrites only the preview helper call in mapToolResultToToolResultBlockParam", async () => {
	const input = `
const tool = {
  mapToolResultToToolResultBlockParam({ stdout, stderr, interrupted, isImageOutput, metadata }) {
    let unrelated = helper(alpha, beta);
    let payload = Y6A(stdout, limitChars);
    return {
      preview: payload.preview,
      hasMore: payload.hasMore,
      unrelated,
      stderr,
      interrupted,
      isImageOutput,
      metadata,
    };
  },
};
`;
	const ast = parse(input);
	await runBashTailViaPasses(ast);
	const output = print(ast);

	assert.equal(
		output.includes(
			"mapToolResultToToolResultBlockParam({ stdout, stderr, interrupted, isImageOutput, metadata, outputTail })",
		),
		true,
	);
	assert.equal(output.includes("let unrelated = helper(alpha, beta);"), true);
	assert.equal(output.includes("payload = outputTail ?"), true);
	assert.equal(output.includes("preview: stdout.slice(-limitChars)"), true);
	assert.equal(output.includes("hasMore: stdout.length > limitChars"), true);
});
