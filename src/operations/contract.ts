import type { NativeFetchResult } from "../native-release.js";

export const OPERATION_RESULT_SCHEMA_VERSION = 1 as const;

export type OperationName = "native-pull";

export interface OperationResult<T> {
	schemaVersion: typeof OPERATION_RESULT_SCHEMA_VERSION;
	operation: OperationName;
	ok: boolean;
	data: T;
}

export interface NativePullResult {
	fetchResult: NativeFetchResult;
	outputJsPath: string;
}

export function createOperationResult<T>(options: {
	operation: OperationName;
	ok: boolean;
	data: T;
}): OperationResult<T> {
	return {
		schemaVersion: OPERATION_RESULT_SCHEMA_VERSION,
		operation: options.operation,
		ok: options.ok,
		data: options.data,
	};
}
