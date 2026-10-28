import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	detectNativeReleasePlatform,
	evictOldVersions,
	fetchNativeRelease,
	formatNativeDownloadFailure,
	getNativeBinaryCandidates,
	resolveNativeReleasePlatform,
} from "./native-release.js";

test("cache eviction keeps releases that the claude command or the official installer still runs", {
	skip: process.platform === "win32",
}, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-evict-"));
	const saved = {
		CC_ENHANCED_OFFICIAL_VERSIONS: process.env.CC_ENHANCED_OFFICIAL_VERSIONS,
		CC_ENHANCED_CLAUDE_LINK: process.env.CC_ENHANCED_CLAUDE_LINK,
		CLAUDE_PATCHER_CACHE_KEEP: process.env.CLAUDE_PATCHER_CACHE_KEEP,
	};
	try {
		const cache = path.join(root, "cache");
		for (const version of ["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5"]) {
			fs.mkdirSync(path.join(cache, version, "linux-x64", "builds"), {
				recursive: true,
			});
			fs.writeFileSync(path.join(cache, version, "linux-x64", "claude"), "");
		}
		const patched = path.join(cache, "1.0.1", "linux-x64", "builds", "patched");
		fs.writeFileSync(patched, "");
		const official = path.join(root, "official-versions");
		fs.mkdirSync(official, { recursive: true });
		fs.symlinkSync(patched, path.join(official, "current"));
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		fs.symlinkSync(
			path.join(cache, "1.0.2", "linux-x64", "claude"),
			path.join(bin, "claude"),
		);
		process.env.CC_ENHANCED_OFFICIAL_VERSIONS = official;
		process.env.CC_ENHANCED_CLAUDE_LINK = path.join(bin, "claude");
		process.env.CLAUDE_PATCHER_CACHE_KEEP = "2";

		evictOldVersions(cache);

		assert.deepEqual(fs.readdirSync(cache).sort(), [
			"1.0.1",
			"1.0.2",
			"1.0.4",
			"1.0.5",
		]);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

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

test("cache eviction protects the installed claude through cache aliases", async (t) => {
	const originalFetch = globalThis.fetch;
	const originalEnv = {
		CC_ENHANCED_CLAUDE_LINK: process.env.CC_ENHANCED_CLAUDE_LINK,
		CC_ENHANCED_OFFICIAL_VERSIONS: process.env.CC_ENHANCED_OFFICIAL_VERSIONS,
		CLAUDE_PATCHER_CACHE_KEEP: process.env.CLAUDE_PATCHER_CACHE_KEEP,
	};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-protected-"));
	const cache = path.join(root, "cache");
	const cacheAlias = path.join(root, "cache-alias");
	const home = path.join(root, "install");
	t.after(() => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	fs.mkdirSync(home, { recursive: true });
	for (const version of ["1.0.0", "1.1.0", "2.0.0", "3.0.0"]) {
		const directory = path.join(cache, version, "linux-x64");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "claude"), `stock ${version}`);
	}
	fs.symlinkSync(cache, cacheAlias, "dir");
	fs.symlinkSync(
		path.join(cacheAlias, "1.0.0", "linux-x64", "claude"),
		path.join(home, "claude"),
	);
	process.env.CC_ENHANCED_CLAUDE_LINK = path.join(home, "claude");
	process.env.CC_ENHANCED_OFFICIAL_VERSIONS = path.join(root, "official");
	process.env.CLAUDE_PATCHER_CACHE_KEEP = "1";
	const bucketUrl = "https://native.example/releases";
	const binaryContent = "stock 4.0.0";
	const checksum = createHash("sha256").update(binaryContent).digest("hex");
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url === `${bucketUrl}/4.0.0/manifest.json`) {
			return new Response(
				JSON.stringify({
					platforms: { "linux-x64": { checksum } },
				}),
			);
		}
		if (url === `${bucketUrl}/4.0.0/linux-x64/claude`) {
			return new Response(binaryContent);
		}
		return new Response("missing", { status: 404 });
	}) as typeof fetch;

	const result = await fetchNativeRelease({
		spec: "4.0.0",
		platform: "linux-x64",
		bucketUrl,
		cacheDir: cacheAlias,
	});

	assert.equal(
		fs.readFileSync(path.join(home, "claude"), "utf8"),
		"stock 1.0.0",
	);
	assert.equal(fs.existsSync(path.join(cache, "1.1.0")), false);
	assert.equal(fs.existsSync(path.join(cache, "2.0.0")), false);
	assert.equal(fs.existsSync(path.join(cache, "3.0.0")), true);
	assert.equal(fs.readFileSync(result.binaryPath, "utf8"), binaryContent);
});
