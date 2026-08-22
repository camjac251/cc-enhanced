import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import {
	buildDesktopCandidate,
	type DesktopCandidateBuildOutput,
	type DesktopCandidateContext,
	type DesktopCandidateEvidence,
	type DesktopCandidateEvidencePaths,
	type DesktopCandidateNativeBuilder,
	readDesktopCandidateContext,
	validateDesktopCandidateEvidence,
} from "../src/desktop/candidate.js";
import { createDesktopCandidateBuildResult } from "../src/desktop/status.js";
import { withHeavyOperationGuard } from "../src/heavy-operation-guard.js";
import { Manager } from "../src/manager.js";
import { renderDesktopCandidateBuild } from "../src/presentation/desktop-candidate.js";
import { renderOperationJson } from "../src/presentation/json.js";

const CANDIDATE_ROOT_PARTS = [".cache", "desktop-candidates"] as const;
const EVIDENCE_OUTPUT_PARTS = [
	".cache",
	"desktop-candidates",
	"evidence",
	"desktop-candidate.json",
] as const;

export interface DesktopCandidateCommandOptions {
	paths: DesktopCandidateEvidencePaths;
	candidateRoot: string;
	evidenceOutput?: string;
	format: "human" | "json" | "evidence";
}

export interface DesktopCandidateCommandDependencies {
	readContext: (
		paths: DesktopCandidateEvidencePaths,
	) => Promise<DesktopCandidateContext>;
	buildCandidate: (options: {
		context: DesktopCandidateContext;
		candidateRoot: string;
		buildNative: DesktopCandidateNativeBuilder;
	}) => Promise<DesktopCandidateBuildOutput>;
	buildNative: DesktopCandidateNativeBuilder;
	writeEvidence: (
		outputPath: string,
		evidence: DesktopCandidateEvidence,
	) => Promise<void>;
}

export interface DesktopCandidateCommandResult {
	exitCode: number;
	output: string;
	data: DesktopCandidateBuildOutput;
}

const buildNativeCandidate: DesktopCandidateNativeBuilder = async (request) => {
	const manager = new Manager({
		patchSelection: request.patchSelection,
		nativeCacheDir: request.candidateRoot,
	});
	const previousLog = console.log;
	console.log = (...args: unknown[]) => console.error(...args);
	try {
		return await manager.buildNative(request.version, {
			platform: request.platform,
		});
	} finally {
		console.log = previousLog;
	}
};

export async function writeDesktopCandidateEvidence(
	outputPath: string,
	evidence: DesktopCandidateEvidence,
): Promise<void> {
	validateDesktopCandidateEvidence(evidence);
	const resolvedOutput = path.resolve(outputPath);
	await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
	try {
		const existing = await fs.lstat(resolvedOutput);
		if (!existing.isFile() || existing.isSymbolicLink()) {
			throw new Error(
				"Desktop candidate evidence output must be a regular file",
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporaryPath = `${resolvedOutput}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(evidence, null, "\t")}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		await fs.rename(temporaryPath, resolvedOutput);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

const defaultDependencies: DesktopCandidateCommandDependencies = {
	readContext: readDesktopCandidateContext,
	buildCandidate: buildDesktopCandidate,
	buildNative: buildNativeCandidate,
	writeEvidence: writeDesktopCandidateEvidence,
};

export async function runDesktopCandidateCommand(
	options: DesktopCandidateCommandOptions,
	dependencies: DesktopCandidateCommandDependencies = defaultDependencies,
): Promise<DesktopCandidateCommandResult> {
	const context = await dependencies.readContext(options.paths);
	const data = await dependencies.buildCandidate({
		context,
		candidateRoot: options.candidateRoot,
		buildNative: dependencies.buildNative,
	});
	const result = createDesktopCandidateBuildResult(data);
	if (options.evidenceOutput) {
		await dependencies.writeEvidence(options.evidenceOutput, data.evidence);
	}
	let output: string;
	if (options.format === "evidence") {
		output = JSON.stringify(data.evidence, null, "\t");
	} else if (options.format === "json") {
		output = renderOperationJson(result);
	} else {
		output = renderDesktopCandidateBuild(result).join("\n");
	}
	return { exitCode: result.ok ? 0 : 1, output: `${output}\n`, data };
}

async function resolveRepositoryCandidateRoot(
	candidateRoot: string,
	repositoryRoot: string,
): Promise<string> {
	const repositoryPath = await fs.realpath(repositoryRoot);
	const expectedInput = path.resolve(repositoryRoot, ...CANDIDATE_ROOT_PARTS);
	if (path.resolve(candidateRoot) !== expectedInput) {
		throw new Error(
			`Candidate root must be ${path.join(...CANDIDATE_ROOT_PARTS)} inside this repository`,
		);
	}
	await fs.mkdir(expectedInput, { recursive: true });
	const candidateLstat = await fs.lstat(expectedInput);
	if (!candidateLstat.isDirectory() || candidateLstat.isSymbolicLink()) {
		throw new Error("Repository candidate root must be a real directory");
	}
	const candidatePath = await fs.realpath(expectedInput);
	if (
		path.relative(repositoryPath, candidatePath) !==
		path.join(...CANDIDATE_ROOT_PARTS)
	) {
		throw new Error(
			"Repository candidate root resolves outside the repository",
		);
	}
	return candidatePath;
}

async function resolveCandidateEvidenceOutput(
	evidenceOutput: string | undefined,
	repositoryRoot: string,
): Promise<string | undefined> {
	if (!evidenceOutput) return undefined;
	const expectedOutput = path.resolve(repositoryRoot, ...EVIDENCE_OUTPUT_PARTS);
	if (path.resolve(evidenceOutput) !== expectedOutput) {
		throw new Error(
			`Evidence output must be ${path.join(...EVIDENCE_OUTPUT_PARTS)}`,
		);
	}
	const expectedParent = path.dirname(expectedOutput);
	await fs.mkdir(expectedParent, { recursive: true });
	const parentLstat = await fs.lstat(expectedParent);
	if (!parentLstat.isDirectory() || parentLstat.isSymbolicLink()) {
		throw new Error("Candidate evidence root must be a real directory");
	}
	const parentPath = await fs.realpath(expectedParent);
	const repositoryPath = await fs.realpath(repositoryRoot);
	if (
		path.relative(repositoryPath, parentPath) !==
		path.join(...EVIDENCE_OUTPUT_PARTS.slice(0, -1))
	) {
		throw new Error(
			"Desktop candidate evidence directory resolves outside the repository",
		);
	}
	return path.join(parentPath, path.basename(expectedOutput));
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.version(false)
		.option("inventory", {
			type: "string",
			demandOption: true,
			description: "Validated path-free Desktop inventory evidence",
		})
		.option("artifact", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop artifact inspection evidence",
		})
		.option("sdk-contract", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop SDK public-contract evidence",
		})
		.option("probe-plan", {
			type: "string",
			demandOption: true,
			description: "Validated Read/Edit/Write permission probe plan",
		})
		.option("profile-support", {
			type: "string",
			demandOption: true,
			description: "Validated blocked Desktop profile-support evidence",
		})
		.option("stock-preflight", {
			type: "string",
			demandOption: true,
			description: "Validated Desktop stock-preflight evidence",
		})
		.option("stock-baseline", {
			type: "string",
			demandOption: true,
			description: "Accepted exact Desktop stock-baseline receipt",
		})
		.option("candidate-root", {
			type: "string",
			demandOption: true,
			description:
				"Repository-local .cache/desktop-candidates construction root",
		})
		.option("evidence-output", {
			type: "string",
			description:
				"Ignored repository-local path-free candidate evidence output",
		})
		.option("json", {
			type: "boolean",
			description: "Render the shared operation envelope as JSON",
		})
		.option("evidence", {
			type: "boolean",
			description: "Render only path-free candidate evidence",
		})
		.conflicts("evidence", "json")
		.strict()
		.help()
		.parse();
	const candidateRoot = await resolveRepositoryCandidateRoot(
		argv.candidateRoot,
		process.cwd(),
	);
	const evidenceOutput = await resolveCandidateEvidenceOutput(
		argv.evidenceOutput,
		process.cwd(),
	);
	const commandResult = await withHeavyOperationGuard(
		{ operation: "Desktop offline candidate construction" },
		async () =>
			await runDesktopCandidateCommand({
				paths: {
					inventoryPath: argv.inventory,
					artifactPath: argv.artifact,
					sdkContractPath: argv.sdkContract,
					probePlanPath: argv.probePlan,
					profileSupportPath: argv.profileSupport,
					stockPreflightPath: argv.stockPreflight,
					stockBaselinePath: argv.stockBaseline,
				},
				candidateRoot,
				evidenceOutput,
				format: argv.evidence ? "evidence" : argv.json ? "json" : "human",
			}),
	);
	process.stdout.write(commandResult.output);
	process.exitCode = commandResult.exitCode;
}

const entryUrl = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: "";
if (import.meta.url === entryUrl) {
	try {
		await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Desktop candidate construction failed: ${message}\n`);
		process.exitCode = 1;
	}
}
