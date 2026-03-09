export type SignatureExpectation = "selected" | "allow-forced";

export interface VerifyCliAnchorsInput {
	patchedCliPath: string;
	cleanCliPath: string;
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
