import type * as t from "@babel/types";

export interface LocationResult {
	start: number;
	end: number;
	identifiers?: string[];
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

	/** AST-based transformation */
	ast?: (ast: t.File) => void | Promise<void>;

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

	/** Diff output if requested */
	diff?: string;

	/** Limit changes (old -> new values) */
	limits?: {
		linesCap?: [string, string];
		lineChars?: [string, string];
		byteCeiling?: [string, string];
		tokenBudget?: [string, string];
	};
}
