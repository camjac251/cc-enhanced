import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { parse, print } from "./loader.js";
import { buildGroupResults, getPatchMetadata } from "./patch-metadata.js";
import { allPatches, getLimitsChanged, signature } from "./patches/index.js";
import type { Patch, PatchResult, PatchVerification } from "./types.js";

export class PatchRunner {
	private patches: Patch[] = [];
	private injectSignature: boolean;

	constructor(
		patches?: Patch[],
		options?: {
			injectSignature?: boolean;
		},
	) {
		this.patches = patches || allPatches.filter((p) => p !== signature);
		this.injectSignature = options?.injectSignature ?? true;
	}

	async run(
		filePath: string,
		options: { dryRun?: boolean; showDiff?: boolean } = {},
	): Promise<PatchResult> {
		const originalCode = await fs.readFile(filePath, "utf-8");
		let code = originalCode;

		const appliedTags: string[] = [];
		const failedTags: string[] = [];
		const verifications: PatchVerification[] = [];
		const errors: { tag: string; error: Error }[] = [];

		// Phase 1: Run string-based patches
		for (const patch of this.patches) {
			if (!patch.string) continue;

			const spinner = ora({
				text: patch.tag,
				prefixText: "   ",
				color: "blue",
			}).start();

			try {
				code = patch.string(code);
				spinner.succeed(patch.tag);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ tag: patch.tag, error: err });
				spinner.fail(`${patch.tag}: ${err.message}`);
			}
		}

		// Phase 2: Parse AST
		const parseSpinner = ora({
			text: `Parsing AST (${(code.length / 1024 / 1024).toFixed(1)} MB)`,
			prefixText: "   ",
			color: "cyan",
		}).start();
		const ast = parse(code);
		parseSpinner.succeed("AST parsed");

		// Phase 3: Run AST-based patches
		for (const patch of this.patches) {
			if (!patch.ast) continue;

			const spinner = ora({
				text: patch.tag,
				prefixText: "   ",
				color: "blue",
			}).start();

			try {
				await patch.ast(ast);
				spinner.succeed(patch.tag);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ tag: patch.tag, error: err });
				spinner.fail(`${patch.tag}: ${err.message}`);
			}
		}

		// Phase 4: Print AST to code
		const output = print(ast);

		// Phase 5: Verify all patches
		for (const patch of this.patches) {
			if (patch === signature) continue; // Skip signature verification for now

			try {
				const result = patch.verify(output, ast);
				const meta = getPatchMetadata(patch.tag);
				if (result === true) {
					verifications.push({
						tag: patch.tag,
						passed: true,
						group: meta.group,
						label: meta.label,
					});
					appliedTags.push(patch.tag);
				} else {
					// result is a string describing the failure
					verifications.push({
						tag: patch.tag,
						passed: false,
						reason: result,
						group: meta.group,
						label: meta.label,
					});
					failedTags.push(patch.tag);
				}
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				const meta = getPatchMetadata(patch.tag);
				verifications.push({
					tag: patch.tag,
					passed: false,
					reason,
					group: meta.group,
					label: meta.label,
				});
				failedTags.push(patch.tag);
			}
		}

		// Phase 6: Inject signature with applied tags (use same AST, don't re-parse)
		if (this.injectSignature && appliedTags.length > 0) {
			const sigSpinner = ora({
				text: "signature",
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				// Pass applied tags to signature patch (modifies ast in place)
				(signature.ast as any)(ast, appliedTags);
				sigSpinner.succeed("signature");
			} catch (e) {
				sigSpinner.fail(`signature: ${e}`);
			}
		}

		// Phase 7: Print final output
		const finalOutput = print(ast);

		// diffOutput is no longer computed (external diff prints directly to console)
		const diffOutput: string | undefined = undefined;

		// Generate diff using external diff command (much faster than JS diff on large files)
		if (options.showDiff) {
			const tmpDir = os.tmpdir();
			const origPath = path.join(tmpDir, "claude-patch-orig.js");
			const patchedPath = path.join(tmpDir, "claude-patch-new.js");

			try {
				fsSync.writeFileSync(origPath, originalCode);
				fsSync.writeFileSync(patchedPath, finalOutput);

				// Try delta first (better output), fall back to diff
				let useDelta = false;
				try {
					execFileSync("which", ["delta"], { stdio: "ignore" });
					useDelta = true;
				} catch {
					// delta not available
				}

				try {
					let output: string;
					if (useDelta) {
						output = execFileSync(
							"delta",
							[
								"--no-gitconfig",
								"--side-by-side",
								"--width=180",
								origPath,
								patchedPath,
							],
							{ encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
						);
					} else {
						output = execFileSync("diff", ["-u", origPath, patchedPath], {
							encoding: "utf-8",
							maxBuffer: 50 * 1024 * 1024,
						});
					}
					console.log(output);
				} catch (e: any) {
					// diff returns exit code 1 when files differ, which is expected
					if (e.stdout) {
						const lines = e.stdout.split("\n");
						for (const line of lines) {
							if (line.startsWith("+") && !line.startsWith("+++")) {
								console.log(chalk.green(line));
							} else if (line.startsWith("-") && !line.startsWith("---")) {
								console.log(chalk.red(line));
							} else if (line.startsWith("@@")) {
								console.log(chalk.cyan(line));
							} else {
								console.log(line);
							}
						}
					}
				}
			} finally {
				// Cleanup temp files
				try {
					fsSync.unlinkSync(origPath);
				} catch {}
				try {
					fsSync.unlinkSync(patchedPath);
				} catch {}
			}
		}

		if (options.dryRun) {
			console.log(chalk.yellow("    Dry run - no changes written"));
		} else {
			await fs.writeFile(filePath, finalOutput, "utf-8");
		}

		// Verify signature was injected
		if (this.injectSignature) {
			const sigResult = signature.verify(finalOutput);
			const sigMeta = getPatchMetadata(signature.tag);
			if (sigResult === true) {
				appliedTags.push("signature");
				verifications.push({
					tag: signature.tag,
					passed: true,
					group: sigMeta.group,
					label: sigMeta.label,
				});
			} else {
				failedTags.push("signature");
				verifications.push({
					tag: "signature",
					passed: false,
					reason: sigResult,
					group: sigMeta.group,
					label: sigMeta.label,
				});
			}
		}

		const groupResults = buildGroupResults(verifications);

		return {
			appliedTags,
			failedTags,
			verifications,
			groupResults,
			ast,
			diff: diffOutput,
			limits: getLimitsChanged(),
		};
	}
}
