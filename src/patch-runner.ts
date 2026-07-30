import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
	type AstPassTelemetry,
	type AstPassTelemetryLevel,
	runCombinedAstPasses,
} from "./ast-pass-engine.js";
import { clearTraverseCache } from "./babel.js";
import { parse, print } from "./loader.js";
import { buildGroupResults, getPatchMetadata } from "./patch-metadata.js";
import { allPatches, getLimitsChanged, signature } from "./patches/index.js";
import {
	emitMemoryCheckpoint,
	forceGarbageCollection,
	isPatcherProfileEnabled,
} from "./profiling.js";
import type {
	AstPassName,
	Patch,
	PatchAstPass,
	PatchResult,
	PatchSemanticWitness,
	PatchVerification,
} from "./types.js";

export type SignatureInjectionPolicy = "auto" | "force" | "off";

interface PatchRunnerRuntime {
	print: typeof print;
	clearTraverseCache: typeof clearTraverseCache;
	forceGarbageCollection: typeof forceGarbageCollection;
	memoryUsage: () => NodeJS.MemoryUsage;
	profileSink: (line: string) => void;
}

const DEFAULT_RUNTIME: PatchRunnerRuntime = {
	print,
	clearTraverseCache,
	forceGarbageCollection,
	memoryUsage: () => process.memoryUsage(),
	profileSink: (line) => console.error(line),
};

const LARGE_VERIFIER_SET_MIN_PATCHES = 32;

function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeVerificationOutcome(result: true | string): {
	passed: boolean;
	reason?: string;
} {
	if (result === true) return { passed: true };
	return { passed: false, reason: result };
}

export class PatchRunner {
	private patches: Patch[] = [];
	private injectSignature: boolean;
	private telemetryLevel: AstPassTelemetryLevel;
	private runtime: PatchRunnerRuntime;

	constructor(
		patches?: Patch[],
		options?: {
			signaturePolicy?: SignatureInjectionPolicy;
			injectSignature?: boolean;
			telemetryLevel?: AstPassTelemetryLevel;
			runtime?: Partial<PatchRunnerRuntime>;
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
		this.telemetryLevel = options?.telemetryLevel ?? "none";
		this.runtime = { ...DEFAULT_RUNTIME, ...options?.runtime };
	}

	async run(
		filePath: string,
		options: { dryRun?: boolean; showDiff?: boolean } = {},
	): Promise<PatchResult> {
		try {
			return await this.runPipeline(filePath, options);
		} finally {
			// A populated cache keeps the complete NodePath/Scope graph resident.
			// Always release it, including when parsing, generation, or writing throws.
			this.profileMemory("patch.cache-before-clear");
			this.runtime.clearTraverseCache();
			this.profileMemory("patch.cache-cleared");
		}
	}

	private profileMemory(checkpoint: string): void {
		emitMemoryCheckpoint(
			checkpoint,
			isPatcherProfileEnabled(),
			this.runtime.memoryUsage,
			this.runtime.profileSink,
		);
	}

	private async runPipeline(
		filePath: string,
		options: { dryRun?: boolean; showDiff?: boolean },
	): Promise<PatchResult> {
		const originalCode = await fs.readFile(filePath, "utf-8");
		let code = originalCode;

		// Optional pipeline profiling, gated by CLAUDE_PATCHER_PROFILE=1.
		// Emits phase timings and passive process-memory checkpoints to stderr.
		const profileEnabled = isPatcherProfileEnabled();
		this.profileMemory("patch.source-loaded");
		const verifyTimings = new Map<string, number>();

		const appliedTags: string[] = [];
		const failedTags: string[] = [];
		const verifications: PatchVerification[] = [];
		const errors: { tag: string; error: Error }[] = [];
		const patchExecutionErrors = new Map<string, string>();
		const semanticWitnesses = new Map<string, PatchSemanticWitness>();
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
		const tBeforeParse = performance.now();
		const parseSpinner = ora({
			text: `Parsing AST (${(code.length / 1024 / 1024).toFixed(1)} MB)`,
			prefixText: "   ",
			color: "cyan",
		}).start();
		const ast = parse(code);
		code = "";
		parseSpinner.succeed("AST parsed");
		const tAfterParse = performance.now();
		this.profileMemory("patch.ast-parsed");

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

		const tBeforePasses = performance.now();
		let astTelemetry: AstPassTelemetry = {
			handlerCalls: {},
			structuralHashes: {},
			overlaps: [],
		};
		if (combinedPatchEntries.length > 0) {
			astTelemetry = await runCombinedAstPasses(
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
				{ telemetryLevel: this.telemetryLevel },
			);
		}

		const tAfterPasses = performance.now();
		this.profileMemory("patch.passes-complete");
		combinedPatchEntries.length = 0;
		this.runtime.clearTraverseCache();
		this.runtime.forceGarbageCollection();
		this.profileMemory("patch.pass-state-released");

		// Phase 4: Print AST to code
		let output = this.runtime.print(ast);
		const tAfterPrint = performance.now();
		this.profileMemory("patch.first-print");

		// Phase 5: Verify all patches
		const verifierCacheReleaseBoundary =
			this.patches.length >= LARGE_VERIFIER_SET_MIN_PATCHES
				? Math.floor(this.patches.length / 2)
				: null;
		for (const [patchIndex, patch] of this.patches.entries()) {
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
				const verifyStart = performance.now();
				const verificationWithWitness = patch.verifyWithWitness
					? patch.verifyWithWitness(output, ast)
					: { result: patch.verify(output, ast) };
				verifyTimings.set(patch.tag, performance.now() - verifyStart);
				const meta = getPatchMetadata(patch.tag);
				const outcome = normalizeVerificationOutcome(
					verificationWithWitness.result,
				);
				if (verificationWithWitness.witness) {
					semanticWitnesses.set(patch.tag, verificationWithWitness.witness);
				}
				if (outcome.passed) {
					verifications.push({
						tag: patch.tag,
						passed: true,
						group: meta.group,
						label: meta.label,
					});
					appliedTags.push(patch.tag);
				} else {
					verifications.push({
						tag: patch.tag,
						passed: false,
						reason: outcome.reason,
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
			} finally {
				this.profileMemory(`patch.verify.${patch.tag}`);
			}
			if (patchIndex + 1 === verifierCacheReleaseBoundary) {
				this.runtime.clearTraverseCache();
				this.runtime.forceGarbageCollection();
				this.profileMemory("patch.verifiers-midpoint-released");
			}
		}
		this.profileMemory("patch.verifiers-complete");
		const signaturePostApply = signature.postApply;
		const shouldAttemptSignature =
			this.injectSignature &&
			failedTags.length === 0 &&
			appliedTags.length > 0 &&
			signaturePostApply !== undefined;
		if (shouldAttemptSignature) {
			output = "";
		}
		this.runtime.clearTraverseCache();
		this.runtime.forceGarbageCollection();
		this.profileMemory("patch.verifier-state-released");

		// Phase 6: Inject signature with applied tags (use same AST, don't re-parse)
		if (shouldAttemptSignature) {
			const sigSpinner = ora({
				text: "signature",
				prefixText: "   ",
				color: "blue",
			}).start();
			try {
				await signaturePostApply(ast, appliedTags);
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

		// Phase 7: Print again only when signature injection could mutate the AST.
		const finalOutput = shouldAttemptSignature
			? this.runtime.print(ast)
			: output;
		output = "";
		this.profileMemory(
			shouldAttemptSignature
				? "patch.final-print"
				: "patch.final-output-reused",
		);

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
			const sigResult = normalizeVerificationOutcome(
				signature.verify(finalOutput, ast),
			);
			const sigMeta = getPatchMetadata(signature.tag);
			if (sigResult.passed) {
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
					reason: sigResult.reason,
					group: sigMeta.group,
					label: sigMeta.label,
				});
			}
		}

		const evidencePatches = verifications.map((verification) => {
			const handlerCalls = astTelemetry.handlerCalls[verification.tag] ?? {
				discover: 0,
				mutate: 0,
				finalize: 0,
			};
			const structuralHashes = astTelemetry.structuralHashes[verification.tag];
			const activeStructuralHashes = structuralHashes
				? Object.fromEntries(
						(["discover", "mutate", "finalize"] as AstPassName[])
							.filter((pass) => handlerCalls[pass] > 0)
							.map((pass) => [pass, structuralHashes[pass]]),
					)
				: undefined;
			const witness = semanticWitnesses.get(verification.tag);
			const hasStructuralActivity =
				handlerCalls.discover + handlerCalls.mutate + handlerCalls.finalize > 0;
			return {
				tag: verification.tag,
				passed: verification.passed,
				coverage: witness
					? ("semantic" as const)
					: hasStructuralActivity
						? ("structural" as const)
						: ("verification" as const),
				handlerCalls,
				...(activeStructuralHashes &&
				Object.keys(activeStructuralHashes).length > 0
					? { structuralHashes: activeStructuralHashes }
					: {}),
				...(witness ? { witness } : {}),
				overlaps: astTelemetry.overlaps.filter((overlap) =>
					overlap.tags.includes(verification.tag),
				),
			};
		});

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
		this.profileMemory("patch.output-complete");

		const groupResults = buildGroupResults(verifications);

		const tAfterVerify = performance.now();
		if (profileEnabled) {
			const parseMs = (tAfterParse - tBeforeParse).toFixed(1);
			const passesMs = (tAfterPasses - tBeforePasses).toFixed(1);
			const printMs = (tAfterPrint - tAfterPasses).toFixed(1);
			const verifyMs = (tAfterVerify - tAfterPrint).toFixed(1);
			const topVerify = [...verifyTimings.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([tag, ms]) => `${tag}=${ms.toFixed(1)}ms`)
				.join(" ");
			this.runtime.profileSink(
				`[profile] parse=${parseMs}ms passes=${passesMs}ms print=${printMs}ms verify=${verifyMs}ms top: ${topVerify}`,
			);
		}

		return {
			appliedTags,
			failedTags,
			verifications,
			groupResults,
			evidence: {
				schemaVersion: 1,
				sourceSha256: sha256Text(originalCode),
				outputSha256: sha256Text(finalOutput),
				patches: evidencePatches,
			},
			limits: getLimitsChanged(),
			errors: errors.map(({ tag, error }) => ({
				tag,
				reason: error.message,
			})),
		};
	}
}
