import type { Patch } from "../types.js";

export type SignatureExpectation = "selected" | "allow-forced";

export interface VerifyCliAnchorsInput {
	patchedCliPath: string;
	cleanCliPath: string;
	selectedPatches?: readonly Patch[];
	skipPatchVerifiers?: boolean;
	signatureExpectation?: SignatureExpectation;
}

export interface AnchorFailure {
	id: string;
	scope: "input" | "patched" | "clean" | "signature" | "patch-verify";
	reason: string;
}

export interface VerifyCliAnchorsResult {
	ok: boolean;
	checksRun: number;
	failures: AnchorFailure[];
	expectedPatchTags: string[];
	actualSignatureTags: string[];
}
