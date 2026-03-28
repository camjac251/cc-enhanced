import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { runCombinedAstPasses } from "./ast-pass-engine.js";
import { parse, print } from "./loader.js";
import { buildGroupResults, getPatchMetadata } from "./patch-metadata.js";
import { allPatches, getLimitsChanged, signature } from "./patches/index.js";
import type {
	Patch,
	PatchAstPass,
	PatchResult,
	PatchVerification,
} from "./types.js";

export type SignatureInjectionPolicy = "auto" | "force" | "off";

export class PatchRunner {
	private patches: Patch[] = [];
	private injectSignature: boolean;

	constructor(
		patches?: Patch[],
		options?: {
			signaturePolicy?: SignatureInjectionPolicy;
			injectSignature?: boolean;
		},
	) {
		const selectedPatches = patches ?? allPatches;
		const hasSignatureSelected = selectedPatches.some(
			(p) => p === signature || p.tag === signature.tag,
		);
		const signaturePolicy =
			options?.signaturePolicy ??
			(options?.injectSignature === undefined
				? "auto"
				: options.injectSignature
					? "force"
					: "off");
		this.patches = selectedPatches.filter(
			(p) => p !== signature && p.tag !== signature.tag,
		);
		this.injectSignature =
			signaturePolicy === "force"
				? true
				: signaturePolicy === "off"
					? false
					: hasSignatureSelected;
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
		const patchExecutionErrors = new Map<string, string>();

		// Phase 1: Run string-based patches
		for (const patch of this.patches) {
			if (!patch.string) continue;
			const meta = getPatchMetadata(patch.tag);

			const spinner = ora({
				text: meta.label,
				prefixText: "   ",
				color: "blue",
			}).start();

			try {
				code = patch.string(code);
				spinner.succeed(meta.label);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ tag: patch.tag, error: err });
				patchExecutionErrors.set(patch.tag, err.message);
				spinner.fail(`${meta.label}: ${err.message}`);
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
		const combinedPatchEntries: Array<{ tag: string; pass: PatchAstPass }> = [];

		for (const patch of this.patches) {
			if (!patch.astPasses) continue;
			const meta = getPatchMetadata(patch.tag);
			const spinner = ora({
				text: `${meta.label} (register)`,
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				const passes = await patch.astPasses(ast);
				for (const pass of passes) {
					combinedPatchEntries.push({ tag: patch.tag, pass });
				}
				spinner.succeed(`${meta.label} (combined)`);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				errors.push({ tag: patch.tag, error: err });
				patchExecutionErrors.set(patch.tag, err.message);
				spinner.fail(`${meta.label}: ${err.message}`);
			}
		}

		if (combinedPatchEntries.length > 0) {
			await runCombinedAstPasses(
				ast,
				combinedPatchEntries,
				(pass, patchCount) => {
					console.log(
						chalk.gray(`   combined-${pass} (${patchCount} patches)`),
					);
				},
				() => {
					// no-op; status emitted in onPassStart to avoid keeping spinner state across async traversal
				},
				(tag, error) => {
					if (!patchExecutionErrors.has(tag)) {
						errors.push({ tag, error });
						patchExecutionErrors.set(tag, error.message);
					}
				},
			);
		}

		// Phase 4: Print AST to code
		const output = print(ast);

		// Phase 5: Verify all patches
		for (const patch of this.patches) {
			try {
				const executionError = patchExecutionErrors.get(patch.tag);
				if (executionError) {
					const meta = getPatchMetadata(patch.tag);
					verifications.push({
						tag: patch.tag,
						passed: false,
						reason: `Patch execution failed: ${executionError}`,
						group: meta.group,
						label: meta.label,
					});
					failedTags.push(patch.tag);
					continue;
				}
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
		if (
			this.injectSignature &&
			failedTags.length === 0 &&
			appliedTags.length > 0 &&
			signature.postApply
		) {
			const sigSpinner = ora({
				text: "signature",
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				await signature.postApply(ast, appliedTags);
				sigSpinner.succeed("signature");
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				sigSpinner.fail(`signature: ${reason}`);
				const sigMeta = getPatchMetadata(signature.tag);
				failedTags.push("signature");
				verifications.push({
					tag: signature.tag,
					passed: false,
					reason: `Signature injection failed: ${reason}`,
					group: sigMeta.group,
					label: sigMeta.label,
				});
			}
		}

		// Phase 7: Print final output
		const finalOutput = print(ast);

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

		// Verify signature was injected
		if (
			this.injectSignature &&
			failedTags.length === 0 &&
			appliedTags.length > 0
		) {
			const sigResult = signature.verify(finalOutput, ast);
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

		if (options.dryRun) {
			console.log(chalk.yellow("    Dry run - no changes written"));
		} else if (failedTags.length === 0) {
			await fs.writeFile(filePath, finalOutput, "utf-8");
		} else {
			console.log(
				chalk.red(
					`    Skipping write due to failed verification tags: ${failedTags.join(", ")}`,
				),
			);
		}

		const groupResults = buildGroupResults(verifications);

		return {
			appliedTags,
			failedTags,
			verifications,
			groupResults,
			ast,
			limits: getLimitsChanged(),
			errors: errors.map(({ tag, error }) => ({ tag, reason: error.message })),
		};
	}
}
