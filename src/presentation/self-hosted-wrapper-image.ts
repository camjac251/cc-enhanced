import type { OperationResult } from "../operations/contract.js";
import type { SelfHostedWrapperImageReceipt } from "../self-hosted/wrapper-image.js";

export function renderSelfHostedWrapperImage(
	result: OperationResult<SelfHostedWrapperImageReceipt>,
): string[] {
	const receipt = result.data;
	return [
		"",
		"Self-hosted Runner Wrapper Image",
		"",
		`  Code version:          ${receipt.upstreamVersion}`,
		`  Platform:              ${receipt.platform}`,
		`  Runtime patches:       ${receipt.runtime.tags.length}`,
		`  Parent image:          ${receipt.parent.imageId}`,
		`  Derived image:         ${receipt.image.id}`,
		`  Registry tags:         ${receipt.image.tags.length}`,
		`  Added layers:          ${receipt.image.layerCount - receipt.image.parentLayerCount}`,
		`  Entrypoint:            ${receipt.image.entrypoint.join(" ")}`,
		`  Default command:       ${receipt.image.defaultCommand.join(" ")}`,
		`  Wrapper path:          ${receipt.wrapper.imagePath}`,
		`  Wrapper owner:         ${receipt.wrapper.owner}`,
		`  Wrapper config:        ${receipt.wrapper.configurationFlag}`,
		`  Assembly method:       ${receipt.build.method}`,
		`  Assembly rootfs:       ${receipt.build.assemblyRootFilesystem}`,
		`  Assembly cleanup:      ${receipt.build.assemblyContainerRemoval}`,
		`  Wrapper version:       ${receipt.runtime.wrapperVersion}`,
		`  Runner help:           ${receipt.runtime.runnerHelp}`,
		`  Context secret scan:   ${receipt.context.textSecretScan.status}`,
		`  Metadata secret scan:  ${receipt.verification.metadataSecretScan}`,
		"",
		"  Live boundaries:",
		`    Actual runner binary: ${receipt.boundaries.actualRunnerProvidedBinary}`,
		`    Runner start:         ${receipt.boundaries.runnerStart}`,
		`    Live control channel: ${receipt.boundaries.liveControlChannel}`,
		`    Doctor:               ${receipt.boundaries.doctor}`,
		`    Client probe:         ${receipt.boundaries.clientProbe}`,
		"",
	];
}
