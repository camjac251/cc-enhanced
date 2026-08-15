import type * as t from "@babel/types";
import type { Visitor } from "./babel.js";

export type AstPassName = "discover" | "mutate" | "finalize";

export interface PatchAstPass {
	pass: AstPassName;
	visitor: Visitor;
}

export interface PatchVerification {
	tag: string;
	passed: boolean;
	reason?: string;
	group?: string;
	label?: string;
}

export interface PatchGroupResult {
	group: string;
	total: number;
	passed: number;
	failed: number;
	appliedTags: string[];
	failedTags: string[];
}

export type PatchWitnessValue = string | number | boolean;

export interface PatchSemanticWitness {
	[key: string]: PatchWitnessValue;
}

export interface PatchVerificationWithWitness {
	result: true | string;
	witness?: PatchSemanticWitness;
}

export type PatchIssueCode =
	| "match-missing"
	| "match-ambiguous"
	| "mutation-missing"
	| "verification-failed"
	| "execution-failed";

export interface PatchVerificationResult {
	passed: boolean;
	issues: PatchIssueCode[];
	diagnostic?: string;
	witness?: PatchSemanticWitness;
}

export interface PatchOutcomeEvidence {
	matched: number;
	mutated: number;
	alreadySatisfied: number;
	verified: 0 | 1;
	issues: PatchIssueCode[];
}

export type PatchVerificationOutput =
	| true
	| string
	| PatchVerificationWithWitness
	| PatchVerificationResult;

export interface PatchOutcomeRecorder {
	recordMatch(outcome: "observed" | "mutated" | "already-satisfied"): void;
	recordIssue(code: PatchIssueCode): void;
	recordVerification(passed: boolean): void;
	snapshot(): PatchOutcomeEvidence;
}

export interface PatchDriftEvidence {
	tag: string;
	passed: boolean;
	coverage: "verification" | "structural" | "semantic";
	handlerCalls: Record<AstPassName, number>;
	structuralHashes?: Partial<
		Record<
			AstPassName,
			{
				beforeSha256: string;
				afterSha256: string;
			}
		>
	>;
	witness?: PatchSemanticWitness;
	outcomes?: PatchOutcomeEvidence;
	overlaps: Array<{
		pass: AstPassName;
		nodeType: string;
		tags: string[];
		count: number;
	}>;
}

export interface PatchEvidenceManifest {
	schemaVersion: 1;
	sourceSha256: string;
	outputSha256: string;
	patches: PatchDriftEvidence[];
}

export type VerificationStageName =
	| "patch"
	| "summary"
	| "evidence"
	| "prompt-surface"
	| "prompt-drift"
	| "anchors";

export interface VerificationStageOutcome {
	stage: VerificationStageName;
	label: string;
	status: "passed" | "failed" | "skipped";
	diagnostic?: string;
}

/**
 * A self-contained patch with optional string/AST transformations and verification.
 */
export interface PatchVerificationContext {
	/**
	 * `mutation` verifies the patch operation that just ran. `artifact` verifies
	 * only state that can be recovered from serialized output.
	 */
	phase: "mutation" | "artifact";
}

export interface Patch {
	/** Signature tag name, e.g., "bash-prompt" */
	tag: string;

	/** String-based transformation (runs before AST parsing) */
	string?: (code: string) => string;

	/** Optional pass-based AST transforms for combined traversal mode */
	astPasses?: (
		ast: t.File,
		recorder?: PatchOutcomeRecorder,
	) => PatchAstPass[] | Promise<PatchAstPass[]>;

	/** Post-verification hook (receives applied tags). Used by signature patch. */
	postApply?: (ast: t.File, appliedTags: string[]) => void | Promise<void>;

	/**
	 * Verify patch applied correctly.
	 * Returns true if successful, or a string describing the failure.
	 */
	verify: (
		code: string,
		ast?: t.File,
		context?: PatchVerificationContext,
	) => true | string;

	/** Verify and return structured, code-free semantic evidence in one pass. */
	verifyWithWitness?: (
		code: string,
		ast?: t.File,
	) => PatchVerificationWithWitness | PatchVerificationResult;
}

/**
 * Result of running all patches
 */
export interface PatchResult {
	/** Tags of successfully verified patches */
	appliedTags: string[];

	/** Tags of patches that failed verification */
	failedTags: string[];

	/** Detailed verification results */
	verifications: PatchVerification[];

	/** Aggregated verification result by patch group */
	groupResults?: PatchGroupResult[];

	/** Runtime patch execution errors captured before verification */
	errors?: Array<{ tag: string; reason: string }>;

	/** Deterministic, code-free evidence for release-to-release comparison */
	evidence?: PatchEvidenceManifest;

	/** Limit changes (old -> new values) */
	limits?: {
		linesCap?: [string, string];
		lineChars?: [string, string];
		byteCeiling?: [string, string];
		tokenBudget?: [string, string];
		resultSizeCap?: [string, string];
		readMaxResultSize?: [string, string];
	};
}
