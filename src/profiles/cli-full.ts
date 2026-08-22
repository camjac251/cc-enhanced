import { registeredPatches } from "../patches/index.js";
import type { PatchProfile } from "./contract.js";

export const cliFullProfile = {
	name: "cli-full",
	surface: "cli",
	includes: registeredPatches.map((patch) => patch.tag),
	excludes: [],
	requiredProbes: [],
} as const satisfies PatchProfile;
