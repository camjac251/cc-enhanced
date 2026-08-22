import { profilePatchCatalog } from "../patches/index.js";
import { resolvePatchSelection } from "../patching/selection.js";
import { cliFullProfile } from "../profiles/cli-full.js";
import type { PatchProfile } from "../profiles/contract.js";
import { remoteControlCandidateProfile } from "../profiles/remote-control.js";
import { selfHostedRunnerCandidateProfile } from "../profiles/self-hosted-runner.js";

export const NATIVE_ARTIFACT_PROFILE_NAMES = [
	"cli-full",
	"remote-control",
	"self-hosted-runner",
] as const;

export type NativeArtifactProfileName =
	(typeof NATIVE_ARTIFACT_PROFILE_NAMES)[number];

const NATIVE_ARTIFACT_PROFILES: Readonly<
	Record<NativeArtifactProfileName, PatchProfile>
> = {
	"cli-full": cliFullProfile,
	"remote-control": remoteControlCandidateProfile,
	"self-hosted-runner": selfHostedRunnerCandidateProfile,
};

export function resolveNativeArtifactPatchSelection(name: string) {
	if (
		!NATIVE_ARTIFACT_PROFILE_NAMES.includes(name as NativeArtifactProfileName)
	) {
		throw new Error(`Unknown native artifact profile ${JSON.stringify(name)}`);
	}
	return resolvePatchSelection({
		catalog: profilePatchCatalog,
		profile: NATIVE_ARTIFACT_PROFILES[name as NativeArtifactProfileName],
	});
}
