import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";

const installer = path.join(process.cwd(), "install.sh");
const posix = process.platform !== "win32";

interface Sandbox {
	root: string;
	home: string;
	officialBin: string;
	prompt: string;
	wrapper: string;
	env: NodeJS.ProcessEnv;
}

/**
 * A throwaway HOME with a fake official `claude` that records each call. Its
 * `plugin marketplace list` reports what `plugin marketplace add` registered,
 * like the real command.
 */
function sandbox(): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-install-"));
	const home = path.join(root, "home");
	const officialBin = path.join(home, ".local", "bin");
	fs.mkdirSync(officialBin, { recursive: true });
	fs.writeFileSync(
		path.join(officialBin, "claude"),
		`#!/usr/bin/env bash
if [[ "\${1:-}" == --version && -n "\${FAKE_CLAUDE_VERSION:-}" ]]; then
  echo "$FAKE_CLAUDE_VERSION (Claude Code)"; exit 0
fi
if [[ "\${1:-}" == plugin ]]; then
  printf '%s\\n' "$*" >> "${root}/plugin-calls"
  if [[ "$2 $3" == "marketplace add" ]]; then echo cc-enhanced > "${root}/marketplaces"; fi
  if [[ "$2 $3" == "marketplace add" && "\${FAKE_MARKETPLACE_REPLACES_ENTRY:-}" == "1" ]]; then
    settings="$HOME/.claude/settings.json"
    jq --arg source "$4" '.extraKnownMarketplaces["cc-enhanced"] = {source: {source: "directory", path: $source}}' "$settings" > "${root}/replaced-settings"
    cat "${root}/replaced-settings" > "$settings"
  fi
  if [[ "$2 $3" == "marketplace list" ]]; then cat "${root}/marketplaces" 2>/dev/null || true; fi
  exit 0
fi
printf '%s\\0' "$@" > "${root}/argv"
printf '%s' "\${CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT-unset}" > "${root}/subagent-env"
printf '%s' "\${CC_ENHANCED_SUBAGENT_PROMPT_FILE-unset}" > "${root}/subagent-marker"
`,
		{ mode: 0o755 },
	);
	const prompt = path.join(root, "system prompt.md");
	fs.writeFileSync(prompt, "policy\n");
	return {
		root,
		home,
		officialBin,
		prompt,
		wrapper: path.join(home, ".local", "share", "cc-enhanced", "bin", "claude"),
		env: {
			// Host tools (bash, awk, sed, jq) without any host claude; the fake is first.
			PATH: [
				officialBin,
				...(process.env.PATH ?? "")
					.split(":")
					.filter((dir) => dir && !fs.existsSync(path.join(dir, "claude"))),
			].join(":"),
			HOME: home,
		},
	};
}

function install(s: Sandbox, args: string[] = []) {
	const result = spawnSync(
		"bash",
		[installer, "--prompt-file", s.prompt, ...args],
		{ encoding: "utf8", env: s.env },
	);
	assert.equal(result.status, 0, result.stderr);
	return result;
}

function runWrapper(s: Sandbox, args: string[], env: NodeJS.ProcessEnv = {}) {
	// The wrapper sits ahead of the official claude, as the shell block arranges.
	const pathWithWrapper = `${path.dirname(s.wrapper)}:${s.env.PATH}`;
	const result = spawnSync(s.wrapper, args, {
		encoding: "utf8",
		env: { ...s.env, PATH: pathWithWrapper, ...env },
	});
	const argvFile = path.join(s.root, "argv");
	const argv = fs.existsSync(argvFile)
		? fs.readFileSync(argvFile, "utf8").split("\0").slice(0, -1)
		: undefined;
	const read = (name: string) => {
		const file = path.join(s.root, name);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
	};
	return {
		...result,
		argv,
		subagentEnv: read("subagent-env"),
		subagentMarker: read("subagent-marker"),
	};
}

function cleanup(t: TestContext, s: Sandbox): void {
	t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
}

test("print-mode wrapper launches append the system prompt to the session and, by flag, to subagents", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);

	const result = runWrapper(s, ["-p", "hello", "--model", "x"], {
		CC_ENHANCED_SUBAGENT_PROMPT_FILE: "/inherited-policy.md",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.argv, [
		"--append-system-prompt-file",
		s.prompt,
		"--append-subagent-system-prompt-file",
		s.prompt,
		"-p",
		"hello",
		"--model",
		"x",
	]);
	assert.equal(result.subagentEnv, "1");
	assert.equal(result.subagentMarker, "unset");
});

test("interactive wrapper launches hand the subagent prompt to the plugin instead of the flag it drops", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);

	const result = runWrapper(s, ["--model", "x"]);
	assert.deepEqual(result.argv, [
		"--append-system-prompt-file",
		s.prompt,
		"--model",
		"x",
	]);
	assert.equal(result.subagentMarker, s.prompt);
	assert.equal(result.subagentEnv, "unset");

	// A caller's own subagent append wins: no marker, so the plugin adds nothing.
	const own = runWrapper(s, ["--append-subagent-system-prompt=mine"], {
		CC_ENHANCED_SUBAGENT_PROMPT_FILE: "/inherited-policy.md",
	});
	assert.equal(own.subagentMarker, "unset");
});

test("wrapper leaves explicit appends to the user and skips appends when the prompt file is unreadable", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);

	const own = runWrapper(s, ["--append-system-prompt=mine"]);
	assert.deepEqual(own.argv, ["--append-system-prompt=mine"]);
	assert.equal(own.subagentMarker, s.prompt);

	// After `--`, a user argument that looks like a flag is a prompt, not an append.
	const literal = runWrapper(s, ["--", "--append-system-prompt"]);
	assert.equal(literal.argv?.[0], "--append-system-prompt-file");

	fs.rmSync(s.prompt);
	const missing = runWrapper(s, ["update"]);
	assert.deepEqual(missing.argv, ["update"]);
	assert.equal(missing.subagentEnv, "unset");
	assert.equal(missing.subagentMarker, "unset");
});

test("CC_ENHANCED_DISABLE runs claude unchanged, and a missing claude fails with install guidance", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);

	const bypass = runWrapper(s, ["--version"], {
		CC_ENHANCED_DISABLE: "1",
		CC_ENHANCED_SUBAGENT_PROMPT_FILE: "/inherited-policy.md",
	});
	assert.deepEqual(bypass.argv, ["--version"]);
	assert.equal(bypass.subagentMarker, "unset");

	fs.rmSync(path.join(s.officialBin, "claude"));
	const absent = runWrapper(s, ["--version"]);
	assert.equal(absent.status, 127);
	assert.match(absent.stderr, /claude\.ai\/install\.sh/);
});

test("install refuses a Claude Code older than the plugin's declared minimum, comparing numerically", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(process.cwd(), "plugin", ".claude-plugin", "plugin.json"),
			"utf8",
		),
	);
	const minimum: string = manifest.metadata.minimumClaudeCodeVersion;
	const [major, minor, patch] = minimum.split(".").map(Number);
	const run = (version: string) =>
		spawnSync(
			"bash",
			[installer, "--prompt-file", s.prompt, "--no-shell", "--no-settings"],
			{
				encoding: "utf8",
				env: { ...s.env, FAKE_CLAUDE_VERSION: version },
			},
		);

	const older = run(`${major}.${minor}.${(patch as number) - 1}`);
	assert.equal(older.status, 1);
	assert.match(
		older.stderr,
		new RegExp(`older than ${minimum.replaceAll(".", "\\.")}.*claude update`),
	);
	assert.equal(fs.existsSync(path.join(s.root, "plugin-calls")), false);
	assert.equal(fs.existsSync(s.wrapper), false);

	assert.equal(run(minimum).status, 0);
	// 2.1.1000 is newer than 2.1.299 even though "1000" sorts before "299" as text.
	assert.equal(run(`${major}.${minor}.${(patch as number) * 10}`).status, 0);

	// Another source may be a different revision, so this checkout's minimum is not applied.
	const elsewhere = spawnSync(
		"bash",
		[
			installer,
			"--source",
			"owner/repo",
			"--prompt-file",
			s.prompt,
			"--no-shell",
			"--no-settings",
		],
		{
			encoding: "utf8",
			env: {
				...s.env,
				FAKE_CLAUDE_VERSION: `${major}.${minor}.${(patch as number) - 1}`,
			},
		},
	);
	assert.equal(elsewhere.status, 0, elsewhere.stderr);
});

test("install registers this checkout as an absolute marketplace, then refreshes it on a rerun", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);
	install(s, ["--no-shell", "--no-settings"]);

	const calls = fs
		.readFileSync(path.join(s.root, "plugin-calls"), "utf8")
		.trim()
		.split("\n");
	const repo = fs.realpathSync(process.cwd());
	assert.deepEqual(
		calls.filter((call) => !call.startsWith("plugin marketplace list")),
		[
			`plugin marketplace add ${repo}`,
			"plugin install cc-enhanced@cc-enhanced",
			"plugin update cc-enhanced@cc-enhanced",
			"plugin marketplace update cc-enhanced",
			"plugin install cc-enhanced@cc-enhanced",
			"plugin update cc-enhanced@cc-enhanced",
		],
	);
});

test("shell blocks are added once, keep existing content, and uninstall restores the file exactly", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	const bashrc = path.join(s.home, ".bashrc");
	const original = "export EXISTING=1\n\n# trailing comment\n";
	fs.writeFileSync(bashrc, original);

	install(s, ["--no-settings"]);
	install(s, ["--no-settings"]);
	const installed = fs.readFileSync(bashrc, "utf8");
	assert.ok(installed.startsWith(original));
	assert.equal(installed.split("# >>> cc-enhanced >>>").length - 1, 1);

	// The block puts the wrapper first in a real shell.
	const resolved = spawnSync(
		"bash",
		["-c", `source ${JSON.stringify(bashrc)}; command -v claude`],
		{ encoding: "utf8", env: s.env },
	);
	assert.equal(resolved.stdout.trim(), s.wrapper);

	const removed = spawnSync("bash", [installer, "--uninstall"], {
		encoding: "utf8",
		env: s.env,
	});
	assert.equal(removed.status, 0, removed.stderr);
	assert.equal(fs.readFileSync(bashrc, "utf8"), original);
	assert.equal(fs.existsSync(path.dirname(s.wrapper)), false);
});

for (const [kind, markers, args] of [
	["unterminated", "# >>> cc-enhanced >>>\n", []],
	["unopened", "# <<< cc-enhanced <<<\n", ["--uninstall"]],
	[
		"nested",
		"# >>> cc-enhanced >>>\n# >>> cc-enhanced >>>\n# <<< cc-enhanced <<<\n# <<< cc-enhanced <<<\n",
		["--uninstall"],
	],
] as const) {
	test(`malformed PATH blocks (${kind}) leave the shell file unchanged`, {
		skip: !posix,
	}, (t) => {
		const s = sandbox();
		cleanup(t, s);
		const bashrc = path.join(s.home, ".bashrc");
		const original = `export KEEP_BEFORE=1\n${markers}export KEEP_AFTER=1\n`;
		fs.writeFileSync(bashrc, original);
		const result = spawnSync(
			"bash",
			[installer, "--no-settings", "--no-agents", ...args],
			{ encoding: "utf8", env: s.env },
		);
		assert.equal(fs.readFileSync(bashrc, "utf8"), original);
		assert.notEqual(result.status, 0);
	});
}

test("settings merge adds only unset keys and enables auto-update on the marketplace Claude Code registered", {
	skip: !posix,
}, (t) => {
	if (spawnSync("bash", ["-c", "command -v jq"]).status !== 0) {
		t.skip("jq is not installed");
		return;
	}
	const s = sandbox();
	cleanup(t, s);
	const settingsFile = path.join(s.home, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(
		settingsFile,
		JSON.stringify({
			ultracode: false,
			env: { KEEP: "1" },
			extraKnownMarketplaces: {
				"cc-enhanced": { source: { source: "directory", path: "/x" } },
				other: { source: { source: "github", repo: "o/r" } },
			},
		}),
	);
	fs.chmodSync(settingsFile, 0o640);

	install(s, ["--no-shell"]);
	const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o640);
	assert.equal(settings.ultracode, false);
	assert.equal(settings.promptCacheTtl, "1h");
	assert.equal(settings.subagentPromptCacheTtl, "1h");
	assert.deepEqual(settings.env, {
		KEEP: "1",
		CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "50000",
	});
	assert.equal(settings.extraKnownMarketplaces["cc-enhanced"].autoUpdate, true);
	assert.equal(settings.extraKnownMarketplaces.other.autoUpdate, undefined);

	// A user's explicit opt-out survives a rerun.
	settings.extraKnownMarketplaces["cc-enhanced"].autoUpdate = false;
	fs.writeFileSync(settingsFile, JSON.stringify(settings));
	install(s, ["--no-shell"]);
	assert.equal(
		JSON.parse(fs.readFileSync(settingsFile, "utf8")).extraKnownMarketplaces[
			"cc-enhanced"
		].autoUpdate,
		false,
	);
});

test("source changes preserve update opt-outs without adding disabled settings defaults", {
	skip: !posix,
}, (t) => {
	if (spawnSync("bash", ["-c", "command -v jq"]).status !== 0) {
		t.skip("jq is not installed");
		return;
	}
	const s = sandbox();
	cleanup(t, s);
	s.env.FAKE_MARKETPLACE_REPLACES_ENTRY = "1";
	const settingsFile = path.join(s.home, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(
		settingsFile,
		JSON.stringify({
			ultracode: false,
			extraKnownMarketplaces: {
				"cc-enhanced": {
					source: { source: "directory", path: "/previous-source" },
					autoUpdate: false,
				},
			},
		}),
	);

	install(s, [
		"--source",
		s.root,
		"--no-shell",
		"--no-settings",
		"--no-agents",
	]);
	const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	assert.equal(
		settings.extraKnownMarketplaces["cc-enhanced"].autoUpdate,
		false,
	);
	assert.equal(settings.ultracode, false);
	assert.equal(settings.promptCacheTtl, undefined);
});

test("settings updates preserve symlinks and target permissions", {
	skip: !posix,
}, (t) => {
	if (spawnSync("bash", ["-c", "command -v jq"]).status !== 0) {
		t.skip("jq is not installed");
		return;
	}
	const s = sandbox();
	cleanup(t, s);
	const settingsFile = path.join(s.home, ".claude", "settings.json");
	const target = path.join(s.root, "managed-settings.json");
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(target, '{"ultracode":false}\n', { mode: 0o600 });
	const link = path.relative(path.dirname(settingsFile), target);
	fs.symlinkSync(link, settingsFile);

	install(s, ["--no-shell", "--no-agents"]);
	assert.equal(fs.lstatSync(settingsFile).isSymbolicLink(), true);
	assert.equal(fs.readlinkSync(settingsFile), link);
	assert.equal(fs.statSync(target).mode & 0o777, 0o600);
	const settings = JSON.parse(fs.readFileSync(target, "utf8"));
	assert.equal(settings.ultracode, false);
	assert.equal(settings.promptCacheTtl, "1h");
});

test("unchanged settings retain their bytes, permissions, and modification time", {
	skip: !posix,
}, (t) => {
	if (spawnSync("bash", ["-c", "command -v jq"]).status !== 0) {
		t.skip("jq is not installed");
		return;
	}
	const s = sandbox();
	cleanup(t, s);
	const settingsFile = path.join(s.home, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	const original = JSON.stringify({
		ultracode: false,
		promptCacheTtl: "5m",
		subagentPromptCacheTtl: "1h",
		env: { CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "32768" },
	});
	fs.writeFileSync(settingsFile, original, { mode: 0o600 });
	const previous = new Date("2000-01-01T00:00:00Z");
	fs.utimesSync(settingsFile, previous, previous);

	install(s, ["--no-shell", "--no-agents"]);
	assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
	assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(settingsFile).mtimeMs, previous.getTime());
});

test("agent defaults preserve custom names across filenames and uninstall only unchanged owned files", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	const agents = path.join(s.home, ".claude", "agents");
	fs.mkdirSync(path.join(agents, "research"), { recursive: true });
	const customPath = path.join(agents, "research", "my-explorer.md");
	const custom =
		"---\nname: 'Explore'\ndescription: Custom researcher\n---\nMy instructions.\n";
	fs.writeFileSync(customPath, custom);
	install(s, ["--no-shell", "--no-settings"]);
	assert.equal(fs.readFileSync(customPath, "utf8"), custom);
	assert.equal(fs.existsSync(path.join(agents, "Explore.md")), false);
	const planPath = path.join(agents, "Plan.md");
	const modified = `${fs.readFileSync(planPath, "utf8")}\nPersonal constraint.\n`;
	fs.writeFileSync(planPath, modified);
	install(s, ["--no-shell", "--no-settings"]);
	assert.equal(fs.readFileSync(planPath, "utf8"), modified);

	const removed = spawnSync("bash", [installer, "--uninstall"], {
		encoding: "utf8",
		env: s.env,
	});
	assert.equal(removed.status, 0, removed.stderr);
	assert.equal(fs.readFileSync(customPath, "utf8"), custom);
	assert.equal(fs.readFileSync(planPath, "utf8"), modified);
});

test("agent defaults refresh unchanged owned files and their saved snapshots", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	install(s, ["--no-shell", "--no-settings"]);
	const target = path.join(s.home, ".claude", "agents", "Explore.md");
	const saved = path.join(
		s.home,
		".local",
		"share",
		"cc-enhanced",
		"agents",
		"Explore.md",
	);
	const current = fs.readFileSync(target, "utf8");
	const previous = "---\nname: Explore\n---\nPrevious default instructions.\n";
	fs.writeFileSync(target, previous);
	fs.writeFileSync(saved, previous);

	install(s, ["--no-shell", "--no-settings"]);
	assert.equal(fs.readFileSync(target, "utf8"), current);
	assert.equal(fs.readFileSync(saved, "utf8"), current);
});

for (const action of ["refresh", "uninstall"]) {
	test(`agent defaults preserve user-replaced symlinks with matching snapshot bytes on ${action}`, {
		skip: !posix,
	}, (t) => {
		const s = sandbox();
		cleanup(t, s);
		install(s, ["--no-shell", "--no-settings"]);
		const target = path.join(s.home, ".claude", "agents", "Explore.md");
		const saved = path.join(
			s.home,
			".local",
			"share",
			"cc-enhanced",
			"agents",
			"Explore.md",
		);
		const external = path.join(s.root, "personal-agent.md");
		const previous =
			"---\nname: Explore\n---\nPrevious default instructions.\n";
		fs.writeFileSync(saved, previous);
		fs.writeFileSync(external, previous);
		fs.rmSync(target);
		fs.symlinkSync(external, target);

		install(
			s,
			action === "refresh" ? ["--no-shell", "--no-settings"] : ["--uninstall"],
		);
		assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
		assert.equal(fs.readlinkSync(target), external);
		assert.equal(fs.readFileSync(external, "utf8"), previous);
		if (action === "refresh") {
			assert.equal(fs.readFileSync(saved, "utf8"), previous);
		} else {
			assert.equal(fs.existsSync(saved), false);
		}
	});
}

test("agent defaults honor the config directory and opt-out, and are removable when unchanged", {
	skip: !posix,
}, (t) => {
	const s = sandbox();
	cleanup(t, s);
	const config = path.join(s.root, "custom config");
	s.env.CLAUDE_CONFIG_DIR = config;
	install(s, ["--no-shell", "--no-settings", "--no-agents"]);
	assert.equal(fs.existsSync(path.join(config, "agents")), false);
	install(s, ["--no-shell", "--no-settings"]);
	assert.equal(fs.existsSync(path.join(s.home, ".claude", "agents")), false);
	const result = spawnSync("bash", [installer, "--uninstall"], {
		encoding: "utf8",
		env: s.env,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(fs.readdirSync(path.join(config, "agents")), []);
});
