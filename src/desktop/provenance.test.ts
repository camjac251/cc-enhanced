import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOfficialDesktopCodeManifestEntry } from "./provenance.js";

function manifest(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: "2.1.235",
		platforms: {
			"win32-x64": {
				binary: "claude.exe",
				checksum: "a".repeat(64),
				size: 326_528_672,
			},
		},
		...extra,
	};
}

test("official provenance fetches one exact bounded release entry", async () => {
	let requestedUrl = "";
	let redirect: RequestRedirect | undefined;
	const entry = await fetchOfficialDesktopCodeManifestEntry({
		version: "2.1.235",
		platform: "win32-x64",
		fetcher: async (input, init) => {
			requestedUrl = String(input);
			redirect = init?.redirect;
			return new Response(JSON.stringify(manifest()), {
				status: 200,
				headers: { "content-length": "512" },
			});
		},
	});

	assert.match(requestedUrl, /\/2[.]1[.]235\/manifest[.]json$/);
	assert.equal(redirect, "error");
	assert.deepEqual(entry, {
		version: "2.1.235",
		platform: "win32-x64",
		binary: "claude.exe",
		size: 326_528_672,
		sha256: "a".repeat(64),
		manifestUrl: requestedUrl,
		manifestSignature: "not-provided",
	});
});

test("official provenance rejects oversized and signature-shaped manifests", async () => {
	await assert.rejects(
		fetchOfficialDesktopCodeManifestEntry({
			version: "2.1.235",
			platform: "win32-x64",
			fetcher: async () =>
				new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 }),
		}),
		/manifest.*limit/i,
	);

	await assert.rejects(
		fetchOfficialDesktopCodeManifestEntry({
			version: "2.1.235",
			platform: "win32-x64",
			fetcher: async () =>
				new Response(JSON.stringify(manifest({ signature: "unverified" })), {
					status: 200,
				}),
		}),
		/explicit verifier/i,
	);
});

test("official provenance rejects version, platform, and binary drift", async () => {
	await assert.rejects(
		fetchOfficialDesktopCodeManifestEntry({
			version: "2.1.235",
			platform: "darwin-arm64",
			fetcher: async () =>
				new Response(JSON.stringify(manifest()), { status: 200 }),
		}),
		/lacks platform/i,
	);
	await assert.rejects(
		fetchOfficialDesktopCodeManifestEntry({
			version: "2.1.236",
			platform: "win32-x64",
			fetcher: async () =>
				new Response(JSON.stringify(manifest()), { status: 200 }),
		}),
		/version/i,
	);
});
