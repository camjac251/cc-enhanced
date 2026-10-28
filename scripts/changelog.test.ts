import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseChangelog,
	selectReleases,
	validatedVersion,
} from "./changelog.js";

const CHANGELOG = `# Changelog

## 2.1.312

- Added click to send for queued messages
- Fixed Write overwriting a very large CLAUDE.md
  after seeing only its start

## 2.1.311

- Added a plugin hook for tool rows

## 2.1.310

- Fixed something old

## 2.1.9

- Ancient entry
`;

test("releases after the validated version are selected by version order, not text order", () => {
	const releases = parseChangelog(CHANGELOG);
	assert.deepEqual(
		selectReleases(releases, { since: "2.1.310" }).map(
			({ version }) => version,
		),
		["2.1.312", "2.1.311"],
	);
	// 2.1.9 is older than 2.1.10 even though "9" sorts after "1" as text.
	assert.deepEqual(
		selectReleases(releases, { since: "2.1.10" }).map(({ version }) => version),
		["2.1.312", "2.1.311", "2.1.310"],
	);
});

test("wrapped entries are joined and --until bounds the newest release", () => {
	const [newest] = selectReleases(parseChangelog(CHANGELOG), {
		since: "2.1.310",
		until: "2.1.312",
	});
	assert.equal(
		newest?.entries[1],
		"Fixed Write overwriting a very large CLAUDE.md after seeing only its start",
	);
	assert.deepEqual(
		selectReleases(parseChangelog(CHANGELOG), {
			since: "2.1.310",
			until: "2.1.311",
		}).map(({ version }) => version),
		["2.1.311"],
	);
});

test("a match keeps only matching entries and drops releases left empty", () => {
	assert.deepEqual(
		selectReleases(parseChangelog(CHANGELOG), {
			since: "2.1.9",
			match: /plugin/i,
		}),
		[{ version: "2.1.311", entries: ["Added a plugin hook for tool rows"] }],
	);
});

test("the validated version comes from the README badge", () => {
	assert.equal(
		validatedVersion(
			'<img src="https://img.shields.io/badge/tested-Claude_Code_2.1.312-8A2BE2">',
		),
		"2.1.312",
	);
	assert.throws(() => validatedVersion("no badge"), /tested-Claude_Code/);
});
