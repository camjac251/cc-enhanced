import type traverse from "@babel/traverse";
import type * as t from "@babel/types";

export type AstPassName = "discover" | "mutate" | "finalize";

export interface PatchAstPass {
	pass: AstPassName;
	visitor: traverse.Visitor;
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

/**
 * A self-contained patch with optional string/AST transformations and verification.
 */
export interface Patch {
	/** Signature tag name, e.g., "bash-prompt" */
	tag: string;

	/** String-based transformation (runs before AST parsing) */
	string?: (code: string) => string;

	/** Optional pass-based AST transforms for combined traversal mode */
	astPasses?: (ast: t.File) => PatchAstPass[] | Promise<PatchAstPass[]>;

	/** Post-verification hook (receives applied tags). Used by signature patch. */
	postApply?: (ast: t.File, appliedTags: string[]) => void | Promise<void>;

	/**
	 * Verify patch applied correctly.
	 * Returns true if successful, or a string describing the failure.
	 */
	verify: (code: string, ast?: t.File) => true | string;
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

	/** The final AST (for signature injection) */
	ast?: t.File;

	/** Runtime patch execution errors captured before verification */
	errors?: Array<{ tag: string; reason: string }>;

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
