import type { NativeFetchResult } from "../native-release.js";
import type { PatchProfileReceipt } from "../profiles/contract.js";
import type { PromoteOptions, PromoteResult } from "../promote.js";
import type {
	ArtifactReceipt,
	NativeArtifactPlatform,
	TargetDescriptor,
} from "../targets/contract.js";
import type { PatchResult } from "../types.js";

export const OPERATION_RESULT_SCHEMA_VERSION = 1 as const;

export type OperationName =
	| "status"
	| "desktop-status"
	| "desktop-compare"
	| "desktop-inspect"
	| "desktop-sdk-contract"
	| "desktop-permission-probe-plan"
	| "desktop-permission-preflight"
	| "desktop-candidate-build"
	| "profile-support"
	| "remote-control-readiness"
	| "remote-control-launch"
	| "self-hosted-readiness"
	| "self-hosted-image-build"
	| "self-hosted-wrapper-probe"
	| "self-hosted-wrapper-image-build"
	| "native-pull"
	| "native-build"
	| "native-update"
	| "promote"
	| "rollback";

export type VerificationCheckStatus = "pass" | "fail" | "skipped";

export interface VerificationCheck {
	id: string;
	status: VerificationCheckStatus;
	detail?: string;
}

export interface OperationWarning {
	code: string;
	message: string;
}

export interface OperationResult<T> {
	schemaVersion: typeof OPERATION_RESULT_SCHEMA_VERSION;
	operation: OperationName;
	ok: boolean;
	target: TargetDescriptor | null;
	profile: PatchProfileReceipt | null;
	artifact: ArtifactReceipt | null;
	checks: VerificationCheck[];
	warnings: OperationWarning[];
	data: T;
}

export interface NativeBuildResult {
	fetchResult: NativeFetchResult;
	patchOutputPath: string;
	patchResult?: PatchResult;
	artifactReceipt: ArtifactReceipt | null;
	dryRun: boolean;
}

export interface NativeBuildOptions {
	platform?: NativeArtifactPlatform;
	forceDownload?: boolean;
}

export interface NativeUpdateResult extends NativeBuildResult {
	promoteResult?: PromoteResult;
}

export interface NativeUpdateOptions extends NativeBuildOptions {
	promoteOptions?: PromoteOptions;
}

export interface NativePullResult {
	fetchResult: NativeFetchResult;
	outputJsPath: string;
}

export function createOperationResult<T>(options: {
	operation: OperationName;
	ok: boolean;
	data: T;
	target?: TargetDescriptor | null;
	profile?: PatchProfileReceipt | null;
	artifact?: ArtifactReceipt | null;
	checks?: readonly VerificationCheck[];
	warnings?: readonly OperationWarning[];
}): OperationResult<T> {
	return {
		schemaVersion: OPERATION_RESULT_SCHEMA_VERSION,
		operation: options.operation,
		ok: options.ok,
		target: options.target ?? null,
		profile: options.profile ?? null,
		artifact: options.artifact ?? null,
		checks: options.checks ? [...options.checks] : [],
		warnings: options.warnings ? [...options.warnings] : [],
		data: options.data,
	};
}
