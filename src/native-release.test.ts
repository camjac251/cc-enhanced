import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	fetchNativeRelease,
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
	const version = "1.2.3";
	const message = formatNativeDownloadFailure(version, "linux-x64", [
		{ candidate: "claude", message: "HTTP 429" },
		{ candidate: "claude.exe", message: "HTTP 404" },
	]);

	assert.match(
		message,
		new RegExp(
			`Could not download native binary for ${version.replaceAll(".", "\\.")}/linux-x64\\. Attempts:`,
		),
	);
	assert.match(message, /- claude: HTTP 429/);
	assert.match(message, /- claude\.exe: HTTP 404/);
});

test("fetchNativeRelease resolves latest to newer npm next tag when available", async (t) => {
	const originalFetch = globalThis.fetch;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-release-"));
	t.after(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const bucketUrl = "https://native.example/releases";
	const registryUrl = "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code";
	const bucketLatest = "9.9.9";
	const npmStable = "9.9.7";
	const npmLatest = "9.9.9";
	const npmNext = "9.9.10";
	const binaryContent = `native ${npmNext}`;
	const checksum = createHash("sha256").update(binaryContent).digest("hex");
	const requests: string[] = [];

	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		requests.push(url);

		if (url === `${bucketUrl}/latest`) {
			return new Response(bucketLatest);
		}

		if (url === registryUrl) {
			return new Response(
				JSON.stringify({
					"dist-tags": {
						stable: npmStable,
						latest: npmLatest,
						next: npmNext,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}

		if (url === `${bucketUrl}/${npmNext}/manifest.json`) {
			return new Response(
				JSON.stringify({
					platforms: {
						"linux-x64": { checksum },
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}

		if (url === `${bucketUrl}/${npmNext}/linux-x64/claude`) {
			return new Response(binaryContent);
		}

		return new Response("missing", { status: 404 });
	}) as typeof fetch;

	const result = await fetchNativeRelease({
		spec: "latest",
		bucketUrl,
		cacheDir: tempDir,
		platform: "linux-x64",
	});

	assert.equal(result.spec, "latest");
	assert.equal(result.version, npmNext);
	assert.equal(result.fromCache, false);
	assert.equal(result.manifestUrl, `${bucketUrl}/${npmNext}/manifest.json`);
	assert.equal(result.binaryUrl, `${bucketUrl}/${npmNext}/linux-x64/claude`);
	assert.equal(fs.readFileSync(result.binaryPath, "utf-8"), binaryContent);
	assert.ok(requests.includes(registryUrl));
});
