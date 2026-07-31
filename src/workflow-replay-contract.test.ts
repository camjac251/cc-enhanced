import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { traverse } from "./babel.js";

const WORKFLOWS = [
	"patch-smoke",
	"release-triage",
	"patch-audit",
	"patch-update",
] as const;

test("state-sensitive workflows invalidate replay from their first agent call", async () => {
	for (const workflow of WORKFLOWS) {
		const workflowPath = new URL(
			`../.claude/workflows/${workflow}.js`,
			import.meta.url,
		);
		const source = await readFile(workflowPath, "utf-8");
		const executableSource = source.replace("export const meta", "const meta");
		const wrappedSource = `async function workflowEntrypoint() {\n${executableSource}\n}`;
		const ast = parse(wrappedSource, {
			sourceType: "module",
		});
		const agentCalls: t.CallExpression[] = [];
		traverse(ast, {
			CallExpression(path) {
				if (t.isIdentifier(path.node.callee, { name: "agent" })) {
					agentCalls.push(path.node);
				}
			},
		});
		agentCalls.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));

		assert.ok(
			agentCalls.length > 1,
			`${workflow}: expected multiple agent calls`,
		);
		const firstStart = agentCalls[0].start ?? -1;
		const replayDeclaration = wrappedSource.indexOf("const replayFingerprint");
		assert.ok(
			replayDeclaration >= 0 && replayDeclaration < firstStart,
			`${workflow}: replay fingerprint must be validated before the first agent call`,
		);
		assert.ok(
			wrappedSource
				.slice(replayDeclaration, firstStart)
				.includes("/^wf-state-v1:[a-f0-9]{64}$/.test(replayFingerprint)"),
			`${workflow}: replay fingerprint validation must fail closed`,
		);
		assert.match(source, /Args: \{[^}]*replayFingerprint/);

		for (const [index, call] of agentCalls.entries()) {
			const callSource = wrappedSource.slice(call.start ?? 0, call.end ?? 0);
			if (index === 0) {
				assert.match(
					callSource,
					/Replay state fingerprint \(cache identity only\): \$\{replayFingerprint\}/,
					`${workflow}: first call is missing the replay identity`,
				);
			} else {
				assert.doesNotMatch(
					callSource,
					/Replay state fingerprint|\$\{replayFingerprint\}/,
					`${workflow}: later call must rely on prefix invalidation`,
				);
			}
		}
	}
});
