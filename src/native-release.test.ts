import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatNativeDownloadFailure,
	getNativeBinaryCandidates,
} from "./native-release.js";

test("getNativeBinaryCandidates prefers native executable name for each platform", () => {
	assert.deepEqual(getNativeBinaryCandidates("linux-x64"), [
		"claude",
		"claude.exe",
	]);
	assert.deepEqual(getNativeBinaryCandidates("darwin-arm64"), [
		"claude",
		"claude.exe",
	]);
	assert.deepEqual(getNativeBinaryCandidates("windows-x64"), [
		"claude.exe",
		"claude",
	]);
});

test("formatNativeDownloadFailure reports every attempted candidate", () => {
	const message = formatNativeDownloadFailure("2.1.89", "linux-x64", [
		{ candidate: "claude", message: "HTTP 429" },
		{ candidate: "claude.exe", message: "HTTP 404" },
	]);

	assert.match(
		message,
		/Could not download native binary for 2\.1\.89\/linux-x64\. Attempts:/,
	);
	assert.match(message, /- claude: HTTP 429/);
	assert.match(message, /- claude\.exe: HTTP 404/);
});
