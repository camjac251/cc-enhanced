import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PatchRunner } from "./patch-runner.js";
import type { Patch } from "./types.js";

test("PatchRunner executes astPasses", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-ast-pass-"));
	const targetPath = path.join(tempDir, "cli.js");
	await fs.writeFile(targetPath, 'const marker = "before";\n', "utf-8");

	let passMutations = 0;
	const patch: Patch = {
		tag: "combined-pass-only",
		astPasses: () => [
			{
				pass: "mutate",
				visitor: {
					StringLiteral(path: any) {
						if (path.node.value !== "before") return;
						path.node.value = "after";
						passMutations += 1;
					},
				},
			},
		],
		verify: (code) => {
			if (!code.includes('"after"')) {
				return "combined pass did not mutate output";
			}
			return true;
		},
	};

	try {
		const runner = new PatchRunner([patch], { signaturePolicy: "off" });
		const result = await runner.run(targetPath);

		assert.equal(passMutations > 0, true);
		assert.equal(result.failedTags.length, 0);
		assert.equal(result.appliedTags.includes("combined-pass-only"), true);

		const written = await fs.readFile(targetPath, "utf-8");
		assert.equal(written.includes('"after"'), true);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
