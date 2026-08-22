import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	detectNativeReleasePlatform,
	fetchNativeRelease,
	formatNativeDownloadFailure,
	getNativeBinaryCandidates,
	resolveNativeReleasePlatform,
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
	assert.deepEqual(getNativeBinaryCandidates("win32-x64"), [
		"claude.exe",
		"claude",
	]);
});

test("native release platform resolution uses official manifest keys", () => {
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "linux",
			architecture: "x64",
			libc: "glibc",
		}),
		"linux-x64",
	);
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "linux",
			architecture: "arm64",
			libc: "musl",
		}),
		"linux-arm64-musl",
	);
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "darwin",
			architecture: "x64",
		}),
		"darwin-x64",
	);
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "darwin",
			architecture: "arm64",
		}),
		"darwin-arm64",
	);
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "win32",
			architecture: "x64",
		}),
		"win32-x64",
	);
	assert.equal(
		resolveNativeReleasePlatform({
			operatingSystem: "win32",
			architecture: "arm64",
		}),
		"win32-arm64",
	);
	assert.match(detectNativeReleasePlatform(), /^(linux|darwin|win32)-/);
});

test("fetchNativeRelease rejects legacy platform aliases before network access", async (t) => {
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = (async () => {
		fetchCalled = true;
		return new Response("unexpected");
	}) as typeof fetch;

	await assert.rejects(
		fetchNativeRelease({
			spec: "1.2.3",
			platform: "windows-x64" as never,
		}),
		/Unsupported native artifact platform/,
	);
	assert.equal(fetchCalled, false);
});

test("fetchNativeRelease uses the official win32 executable path", async (t) => {
	const originalFetch = globalThis.fetch;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-win32-"));
	t.after(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const bucketUrl = "https://native.example/releases";
	const version = "1.2.3";
	const binaryContent = "synthetic win32 artifact";
	const checksum = createHash("sha256").update(binaryContent).digest("hex");
	const requests: string[] = [];

	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		requests.push(url);
		if (url === `${bucketUrl}/${version}/manifest.json`) {
			return new Response(
				JSON.stringify({
					platforms: { "win32-x64": { checksum } },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (url === `${bucketUrl}/${version}/win32-x64/claude.exe`) {
			return new Response(binaryContent);
		}
		return new Response("missing", { status: 404 });
	}) as typeof fetch;

	const result = await fetchNativeRelease({
		spec: version,
		bucketUrl,
		cacheDir: tempDir,
		platform: "win32-x64",
	});

	assert.equal(result.platform, "win32-x64");
	assert.equal(
		result.binaryUrl,
		`${bucketUrl}/${version}/win32-x64/claude.exe`,
	);
	assert.equal(path.basename(result.binaryPath), "claude.exe");
	assert.ok(requests.includes(result.binaryUrl));
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
	const npmNext = "9.9.10-beta.1";
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
