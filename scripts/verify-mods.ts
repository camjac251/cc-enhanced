#!/usr/bin/env bun
import * as path from "node:path";
import { verifyMods } from "../src/verify-mod.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const binaryIndex = args.indexOf("--binary");
const binary = binaryIndex < 0 ? undefined : args[binaryIndex + 1];
if (!binary || binary.startsWith("-") || args.length !== (live ? 3 : 2)) {
	throw new Error(
		"Usage: bun run verify:mods --binary <stock-binary> [--live]",
	);
}
await verifyMods(path.resolve(binary), { live });
