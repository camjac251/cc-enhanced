import { cliFullProfile } from "./cli-full.js";
import type { PatchProfile } from "./contract.js";

export { desktopLocalCandidateProfile } from "./desktop-local.js";
export { remoteControlCandidateProfile } from "./remote-control.js";
export { selfHostedRunnerCandidateProfile } from "./self-hosted-runner.js";

export const patchProfiles: readonly PatchProfile[] = [cliFullProfile];

export function getPatchProfile(name: string): PatchProfile {
	const profile = patchProfiles.find((candidate) => candidate.name === name);
	if (profile) return profile;

	throw new Error(
		`Unknown patch profile "${name}". Available profiles: ${patchProfiles
			.map((candidate) => candidate.name)
			.join(", ")}`,
	);
}
