#!/usr/bin/env bun
import {
	initializeMemoryScope,
	runMemoryLimited,
} from "../src/memory-budget.js";

try {
	const args = process.argv.slice(2);
	let commandIndex = args[0] === "--" ? 1 : 0;
	let scope: string | undefined;
	if (args[0] === "--inside") {
		if (!args[1] || args[2] !== "--") {
			throw new Error(
				"Internal usage: --inside <generated-scope> -- <command> [args...]",
			);
		}
		scope = args[1];
		commandIndex = 3;
	}
	// Bun consumes a leading argv separator after the script filename, but
	// preserves the separator following the internal bootstrap arguments.
	if (!args[commandIndex] || args[commandIndex].startsWith("--")) {
		throw new Error(
			"Usage: bun scripts/run-memory-limited.ts -- <command> [args...]",
		);
	}
	if (scope) initializeMemoryScope(scope);
	process.exitCode = await runMemoryLimited(
		args[commandIndex],
		args.slice(commandIndex + 1),
	);
} catch (error) {
	console.error(
		`[memory] Refusing to run: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
