import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const MARKER = "CC_ENHANCED_SUBAGENT_PROMPT_FILE";
const FILE = "/etc/claude-code/system-prompt.md";

function environment(
	on: On,
	values: Record<string, string>,
	files: Record<string, string>,
) {
	const reads: string[] = [];
	// Stands in for the engine and other hooks beneath the plugin.
	on("classic.SubagentStart", () => ({
		additionalContext: ["from another hook"],
	}));
	on("env.get", (_$, e) => ({ value: values[e.name] }));
	on("fs.read", (_$, e) => {
		reads.push(e.path);
		if (!(e.path in files)) throw new Error("ENOENT");
		return { value: files[e.path] };
	});
	return reads;
}

test("an interactive wrapper launch adds the policy file to a starting subagent", async ($, on) => {
	const reads = environment(
		on,
		{ [MARKER]: FILE },
		{ [FILE]: "Follow the policy.\n" },
	);
	const result = await $.classic.SubagentStart({
		agent_id: "a1",
		agent_type: "general-purpose",
	});
	expect(result.additionalContext).toEqual([
		"from another hook",
		"Follow the policy.\n",
	]);
	expect(reads).toEqual([FILE]);
});

test("without the wrapper's marker nothing is added and no file is read", async ($, on) => {
	const reads = environment(on, {}, { [FILE]: "Follow the policy.\n" });
	const result = await $.classic.SubagentStart({
		agent_id: "a1",
		agent_type: "Explore",
	});
	expect(result.additionalContext).toEqual(["from another hook"]);
	expect(reads).toEqual([]);
});

test("forks inherit the main prompt, so they get nothing extra", async ($, on) => {
	const reads = environment(
		on,
		{ [MARKER]: FILE },
		{ [FILE]: "Follow the policy.\n" },
	);
	const result = await $.classic.SubagentStart({
		agent_id: "a1",
		agent_type: "fork",
	});
	expect(result.additionalContext).toEqual(["from another hook"]);
	expect(reads).toEqual([]);
});

test("an unreadable policy file adds nothing", async ($, on) => {
	environment(on, { [MARKER]: "/missing.md" }, {});
	const missing = await $.classic.SubagentStart({
		agent_id: "a1",
		agent_type: "Plan",
	});
	expect(missing.additionalContext).toEqual(["from another hook"]);
});

test("a disabled wrapper policy cannot leak through an inherited marker", async ($, on) => {
	const reads = environment(
		on,
		{ [MARKER]: FILE, CC_ENHANCED_DISABLE: "1" },
		{ [FILE]: "Follow the policy.\n" },
	);
	const result = await $.classic.SubagentStart({
		agent_id: "a1",
		agent_type: "general-purpose",
	});
	expect(result.additionalContext).toEqual(["from another hook"]);
	expect(reads).toEqual([]);
});
