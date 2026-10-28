#!/usr/bin/env bun
/**
 * Print Claude Code's upstream changelog for the releases after the last
 * version this repo validated (the README badge), so a maintainer can see what
 * changed before refreshing types and running the live mod check.
 *
 *   bun run changelog                         releases after the README badge
 *   bun run changelog --since 2.1.294         releases after 2.1.294
 *   bun run changelog --match 'plugin|hook'   only matching entries
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compareReleaseVersions } from "../src/version-order.js";

const CHANGELOG_URL =
	"https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\s*$/;

export interface ChangelogRelease {
	version: string;
	entries: string[];
}

/** Split the changelog into releases, newest first as published. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
	const releases: ChangelogRelease[] = [];
	let current: ChangelogRelease | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = VERSION_HEADING.exec(line);
		if (heading) {
			current = { version: heading[1] as string, entries: [] };
			releases.push(current);
		} else if (current && line.startsWith("- ")) {
			current.entries.push(line.slice(2).trim());
		} else if (current && /^\s+\S/.test(line) && current.entries.length > 0) {
			// Wrapped continuation of the previous entry.
			const last = current.entries.length - 1;
			current.entries[last] = `${current.entries[last]} ${line.trim()}`;
		}
	}
	return releases;
}

/** Releases newer than `since` and no newer than `until`, keeping matching entries. */
export function selectReleases(
	releases: readonly ChangelogRelease[],
	options: { since: string; until?: string; match?: RegExp },
): ChangelogRelease[] {
	return releases
		.filter(
			({ version }) =>
				compareReleaseVersions(version, options.since) > 0 &&
				(options.until === undefined ||
					compareReleaseVersions(version, options.until) <= 0),
		)
		.map((release) => ({
			version: release.version,
			entries: options.match
				? release.entries.filter((entry) => options.match?.test(entry))
				: release.entries,
		}))
		.filter((release) => release.entries.length > 0 || !options.match);
}

/** The version the README badge records as last validated. */
export function validatedVersion(readme: string): string {
	const match = /tested-Claude_Code_(\d+\.\d+\.\d+)/.exec(readme);
	if (!match)
		throw new Error("README has no tested-Claude_Code_<version> badge");
	return match[1] as string;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} needs a value`);
	}
	return value;
}

async function main(args: string[]): Promise<void> {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const since =
		option(args, "--since") ??
		validatedVersion(fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"));
	const until = option(args, "--until");
	const pattern = option(args, "--match");
	const file = option(args, "--file");

	const markdown = file
		? fs.readFileSync(file, "utf8")
		: await fetch(CHANGELOG_URL).then((response) => {
				if (!response.ok) {
					throw new Error(
						`Fetching the changelog failed: HTTP ${response.status}`,
					);
				}
				return response.text();
			});
	const releases = parseChangelog(markdown);
	const selected = selectReleases(releases, {
		since,
		until,
		match: pattern ? new RegExp(pattern, "i") : undefined,
	});
	const newest = releases[0]?.version ?? "unknown";
	if (selected.length === 0) {
		console.log(
			`No changelog entries after ${since} (newest published: ${newest}).`,
		);
		return;
	}
	const count = selected.reduce((sum, { entries }) => sum + entries.length, 0);
	console.log(
		`# Claude Code changes after ${since}${until ? ` through ${until}` : ""}${pattern ? ` matching /${pattern}/i` : ""}\n\n${count} entries in ${selected.length} releases; newest published: ${newest}.\n`,
	);
	for (const release of selected) {
		console.log(`## ${release.version}\n`);
		for (const entry of release.entries) console.log(`- ${entry}`);
		console.log("");
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
