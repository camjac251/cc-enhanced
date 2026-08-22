import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedImageReceipt } from "../self-hosted/image.js";

export function renderSelfHostedImage(
	result: OperationResult<SelfHostedImageReceipt>,
): string[] {
	const receipt = result.data;
	return [
		"",
		"Self-hosted Runner Image",
		"",
		`  Code version:          ${receipt.upstreamVersion}`,
		`  Platform:              ${receipt.platform}`,
		`  Runtime patches:       ${receipt.runtime.tags.length}`,
		`  Image ID:              ${receipt.image.id}`,
		`  Base:                  ${receipt.base.reference}`,
		`  Base pull:             ${receipt.base.pull}`,
		`  Registry tags:         ${receipt.image.tags.length}`,
		`  Runtime user:          ${receipt.image.user}`,
		`  Working directory:     ${receipt.image.workingDirectory}`,
		`  Entrypoint:            ${receipt.image.entrypoint.join(" ")}`,
		`  Default command:       ${receipt.image.defaultCommand.join(" ")}`,
		`  Context secret scan:   ${receipt.context.textSecretScan.status}`,
		`  Metadata secret scan:  ${receipt.verification.metadataSecretScan}`,
		"",
		"  Live boundaries:",
		`    Runner start:        ${receipt.boundaries.runnerStart}`,
		`    Runner registration: ${receipt.boundaries.runnerRegistration}`,
		`    Child session:       ${receipt.boundaries.childSession}`,
		`    Client probe:        ${receipt.boundaries.clientProbe}`,
		"",
	];
}
