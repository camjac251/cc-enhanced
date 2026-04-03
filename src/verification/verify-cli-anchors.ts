import * as fs from "node:fs/promises";
import { parse } from "../loader.js";
import { hasStrongClaudeMdDisclaimer } from "../patches/claudemd-strong.js";
import { allPatches } from "../patches/index.js";
import type {
	AnchorFailure,
	SignatureExpectation,
	VerifyCliAnchorsInput,
	VerifyCliAnchorsResult,
} from "./anchor-types.js";

type AnchorRule = { id: string; needle: string; reason: string };
type RegexRule = { id: string; pattern: RegExp; reason: string };

const REQUIRED_FIXED_PATCHED: AnchorRule[] = [
	{
		id: "policy-apply-patch",
		needle:
			"Never use cat/echo/printf for file writes - use Write or Edit tools.",
		reason: "Missing enforced file-write tool policy",
	},
	{
		id: "debug-read-bash",
		needle: 'allowedTools: ["Read", "Bash"]',
		reason: "Missing debug command Read+Bash restriction",
	},
	{
		id: "read-range-desc",
		needle: "Line range using supported bat-style forms",
		reason: "Missing read-bat range description",
	},
	{
		id: "changed-file-truncation",
		needle: "[TRUNCATED - changed-file diff head+tail summary]",
		reason: "Missing changed-file truncation marker",
	},
	{
		id: "mcp-server-msg",
		needle:
			"Server name can only contain letters, numbers, hyphens, underscores, colons, dots, and slashes",
		reason: "Missing MCP server name validation message",
	},
	{
		id: "sys-prompt-env",
		needle: "CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE",
		reason: "Missing system prompt env override",
	},
	{
		id: "session-mem-env",
		needle: "ENABLE_SESSION_MEMORY",
		reason: "Missing session memory env override",
	},
	{
		id: "autoupdate-off",
		needle: 'return "patched";',
		reason: "Missing autoupdater early return",
	},
];

const FORBIDDEN_FIXED_PATCHED: AnchorRule[] = [
	{
		id: "legacy-debug-grep-glob",
		needle: 'allowedTools: ["Read", "Grep", "Glob"]',
		reason: "Legacy debug Grep/Glob allowance still present",
	},
	{
		id: "legacy-grep-glob-guidance",
		needle: "Use Grep or Glob when you need to search broadly.",
		reason: "Legacy Grep/Glob guidance still present",
	},
	{
		id: "legacy-hook-glob-grep",
		needle:
			"**Common tool matchers:** \\`Bash\\`, \\`Write\\`, \\`Edit\\`, \\`Read\\`, \\`Glob\\`, \\`Grep\\`",
		reason: "Legacy hook matcher Glob/Grep docs still present",
	},
	{
		id: "legacy-webfetch-md-heading",
		needle: "## When to Use WebFetch",
		reason: "Legacy markdown WebFetch heading still present",
	},
	{
		id: "legacy-webfetch-html-heading",
		needle: "<h2>When to Use WebFetch</h2>",
		reason: "Legacy HTML WebFetch heading still present",
	},
];

const REQUIRED_REGEX_PATCHED: RegexRule[] = [
	{
		id: "policy-gh-api",
		pattern: /Always use .*gh api.*for GitHub URLs, not web fetching tools\./,
		reason: "Missing enforced gh api policy",
	},
	{
		id: "policy-bat",
		pattern: /Always use .*bat.*to view files, not cat\/head\/tail\./,
		reason: "Missing enforced bat policy",
	},
	{
		id: "policy-sg-rg",
		pattern:
			/Always use .*sg.*for code search, .*rg.*only for text\/logs\/config\. Prefer sg over rg\./,
		reason: "Missing enforced sg/rg policy",
	},
	{
		id: "hook-matcher-agent",
		pattern: /\*\*Common tool matchers:\*\* [^\n]*\\?`Agent\\?`/,
		reason: "Missing updated hook matcher tool list with Agent",
	},
	// changed-file-guard anchor removed: the readFileState.set() compatibility
	// markers (offset: 1, limit: 1 for partial reads) already cause the
	// offset/limit guard to fire, making the explicit range check redundant.
	{
		id: "read-state-guard",
		pattern:
			/if\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]*(\?\.)?file_path\s*&&\s*[A-Za-z_$][A-Za-z0-9_$]*(\?\.)?offset\s*===\s*void 0\s*&&\s*[A-Za-z_$][A-Za-z0-9_$]*(\?\.)?limit\s*===\s*void 0\s*&&\s*[A-Za-z_$][A-Za-z0-9_$]*(\?\.)?range\s*===\s*void 0[\s\S]{0,260}\)/,
		reason: "Missing range-aware transcript read-state guard",
	},
];

const FORBIDDEN_REGEX_PATCHED: RegexRule[] = [
	{
		id: "legacy-hook-glob-grep-re",
		pattern: /\*\*Common tool matchers:\*\* .*Glob.*Grep/,
		reason: "Legacy hook matcher Glob/Grep docs still present",
	},
	{
		id: "legacy-built-in-tool-rows",
		pattern:
			/<tr><td>(Glob|Grep|WebSearch|WebFetch)<\/td><td>[^<]*<\/td><\/tr>/,
		reason: "Legacy built-in tools table disabled rows still present",
	},
];

function collectSelectedPatchTags(): string[] {
	return allPatches
		.map((patch) => patch.tag)
		.filter((tag) => tag !== "signature")
		.sort();
}

function parseSignatureTags(code: string): string[] {
	const match = code.match(/\(Claude Code; patched: ([^)]+)\)/);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean)
		.sort();
}

function pushFailure(
	failures: AnchorFailure[],
	scope: AnchorFailure["scope"],
	id: string,
	reason: string,
) {
	failures.push({ scope, id, reason });
}

function checkRequiredFixed(
	code: string,
	scope: AnchorFailure["scope"],
	failures: AnchorFailure[],
): number {
	let checksRun = 0;
	for (const rule of REQUIRED_FIXED_PATCHED) {
		checksRun++;
		if (!code.includes(rule.needle)) {
			pushFailure(failures, scope, rule.id, rule.reason);
		}
	}
	return checksRun;
}

function checkForbiddenFixed(
	code: string,
	scope: AnchorFailure["scope"],
	failures: AnchorFailure[],
): number {
	let checksRun = 0;
	for (const rule of FORBIDDEN_FIXED_PATCHED) {
		checksRun++;
		if (code.includes(rule.needle)) {
			pushFailure(failures, scope, rule.id, rule.reason);
		}
	}
	return checksRun;
}

function checkRequiredRegex(
	code: string,
	scope: AnchorFailure["scope"],
	failures: AnchorFailure[],
): number {
	let checksRun = 0;
	for (const rule of REQUIRED_REGEX_PATCHED) {
		checksRun++;
		if (!rule.pattern.test(code)) {
			pushFailure(failures, scope, rule.id, rule.reason);
		}
	}
	return checksRun;
}

function checkForbiddenRegex(
	code: string,
	scope: AnchorFailure["scope"],
	failures: AnchorFailure[],
): number {
	let checksRun = 0;
	for (const rule of FORBIDDEN_REGEX_PATCHED) {
		checksRun++;
		if (rule.pattern.test(code)) {
			pushFailure(failures, scope, rule.id, rule.reason);
		}
	}
	return checksRun;
}

function checkReadRangeMarker(
	patchedCode: string,
	failures: AnchorFailure[],
): number {
	const hasNormalizedRange = patchedCode.includes(
		'args.push("-r", normalizedRange)',
	);
	const hasRangeParamText = patchedCode.includes(
		"Range parameter (for text files only, supported bat-style forms):",
	);
	if (!hasNormalizedRange && !hasRangeParamText) {
		pushFailure(
			failures,
			"patched",
			"read-bat-range-marker",
			"Missing read-bat normalized range usage (legacy or native marker)",
		);
	}
	return 1;
}

function checkClaudeMdMarkers(
	patchedCode: string,
	failures: AnchorFailure[],
): number {
	if (!hasStrongClaudeMdDisclaimer(patchedCode)) {
		pushFailure(
			failures,
			"patched",
			"claudemd-wrapper",
			"Missing strong CLAUDE.md wrapper disclaimer invariants",
		);
	}
	return 1;
}

function checkSignatureParity(
	patchedCode: string,
	failures: AnchorFailure[],
	expectation: SignatureExpectation,
): { checksRun: number; actualSignatureTags: string[] } {
	let checksRun = 0;
	const selectedIncludesSignature = allPatches.some(
		(patch) => patch.tag === "signature",
	);
	const allowForcedSignature = expectation === "allow-forced";
	const expectsSignature = allowForcedSignature
		? true
		: selectedIncludesSignature;
	const hasSignature = /\(Claude Code; patched: [^)]+\)/.test(patchedCode);
	const actualSignatureTags = parseSignatureTags(patchedCode);

	checksRun++;
	if (expectsSignature && !hasSignature) {
		pushFailure(
			failures,
			"signature",
			"signature-missing",
			"Signature expected but missing from patched cli.js",
		);
		return { checksRun, actualSignatureTags };
	}

	checksRun++;
	if (!expectsSignature && hasSignature && !allowForcedSignature) {
		pushFailure(
			failures,
			"signature",
			"signature-unexpected",
			"Signature present despite being excluded by tag filters",
		);
		return { checksRun, actualSignatureTags };
	}

	if (!hasSignature) {
		return { checksRun, actualSignatureTags };
	}

	const expectedTags = collectSelectedPatchTags();
	const expectedSet = new Set(expectedTags);
	const actualSet = new Set(actualSignatureTags);
	const missing = expectedTags.filter((tag) => !actualSet.has(tag));
	const extra = actualSignatureTags.filter((tag) => !expectedSet.has(tag));

	checksRun++;
	if (missing.length > 0) {
		pushFailure(
			failures,
			"signature",
			"signature-missing-tags",
			`Signature missing tags: ${missing.join(", ")}`,
		);
	}

	checksRun++;
	if (extra.length > 0) {
		pushFailure(
			failures,
			"signature",
			"signature-extra-tags",
			`Signature has extra tags: ${extra.join(", ")}`,
		);
	}

	return { checksRun, actualSignatureTags };
}

function runPatchVerifiers(
	patchedCode: string,
	failures: AnchorFailure[],
): number {
	let checksRun = 0;
	let ast: any;
	try {
		ast = parse(patchedCode);
	} catch (error) {
		const reason =
			error instanceof Error
				? error.message
				: `Unknown parse error: ${String(error)}`;
		pushFailure(
			failures,
			"patch-verify",
			"patch-verify-parse-failed",
			`Failed to parse patched cli.js for patch verification: ${reason}`,
		);
		return 1;
	}

	for (const patch of allPatches) {
		if (patch.tag === "signature") continue;
		checksRun++;
		try {
			const result = patch.verify(patchedCode, ast);
			if (result !== true) {
				pushFailure(
					failures,
					"patch-verify",
					`patch-verify-${patch.tag}`,
					`${patch.tag}: ${result}`,
				);
			}
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown verify error: ${String(error)}`;
			pushFailure(
				failures,
				"patch-verify",
				`patch-verify-${patch.tag}`,
				`${patch.tag}: verify threw: ${reason}`,
			);
		}
	}

	return checksRun;
}

async function readCliInputs(
	input: VerifyCliAnchorsInput,
	failures: AnchorFailure[],
): Promise<{ patchedCode: string; cleanCode: string } | null> {
	const paths: Array<{
		path: string;
		id: string;
		label: "patched" | "clean";
	}> = [
		{
			path: input.patchedCliPath,
			id: "input-patched-not-readable",
			label: "patched",
		},
		{
			path: input.cleanCliPath,
			id: "input-clean-not-readable",
			label: "clean",
		},
	];

	const accessChecks = await Promise.allSettled(
		paths.map((entry) => fs.access(entry.path)),
	);
	for (const [index, check] of accessChecks.entries()) {
		if (check.status === "fulfilled") continue;
		pushFailure(
			failures,
			"input",
			paths[index].id,
			`Cannot read ${paths[index].label} cli.js at ${paths[index].path}: ${check.reason}`,
		);
	}
	if (failures.length > 0) return null;

	try {
		const [patchedCode, cleanCode] = await Promise.all([
			fs.readFile(input.patchedCliPath, "utf-8"),
			fs.readFile(input.cleanCliPath, "utf-8"),
		]);
		return { patchedCode, cleanCode };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		pushFailure(
			failures,
			"input",
			"input-read-failed",
			`Failed to read verifier inputs: ${reason}`,
		);
		return null;
	}
}

export async function verifyCliAnchors(
	input: VerifyCliAnchorsInput,
): Promise<VerifyCliAnchorsResult> {
	const failures: AnchorFailure[] = [];
	let checksRun = 0;
	checksRun += 2;

	const codes = await readCliInputs(input, failures);
	if (!codes) {
		return {
			ok: false,
			checksRun,
			failures,
			expectedPatchTags: collectSelectedPatchTags(),
			actualSignatureTags: [],
		};
	}
	const { patchedCode, cleanCode } = codes;

	checksRun++;
	if (cleanCode.includes("(Claude Code; patched:")) {
		pushFailure(
			failures,
			"clean",
			"clean-has-signature",
			"Found forbidden signature in clean cli.js",
		);
	}

	checksRun += checkRequiredFixed(patchedCode, "patched", failures);
	checksRun += checkForbiddenFixed(patchedCode, "patched", failures);
	checksRun += checkRequiredRegex(patchedCode, "patched", failures);
	checksRun += checkForbiddenRegex(patchedCode, "patched", failures);
	checksRun += checkReadRangeMarker(patchedCode, failures);
	checksRun += checkClaudeMdMarkers(patchedCode, failures);
	if (!input.skipPatchVerifiers) {
		checksRun += runPatchVerifiers(patchedCode, failures);
	}

	const signatureCheck = checkSignatureParity(
		patchedCode,
		failures,
		input.signatureExpectation ?? "selected",
	);
	checksRun += signatureCheck.checksRun;

	return {
		ok: failures.length === 0,
		checksRun,
		failures,
		expectedPatchTags: collectSelectedPatchTags(),
		actualSignatureTags: signatureCheck.actualSignatureTags,
	};
}
