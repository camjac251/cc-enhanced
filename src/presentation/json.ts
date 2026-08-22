import type { OperationResult } from "../operations/contract.js";

export function renderOperationJson(result: OperationResult<unknown>): string {
	return JSON.stringify(result, null, 2);
}
