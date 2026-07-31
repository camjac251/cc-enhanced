import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CACHE_DIAGNOSTICS_BETA,
	type CacheDiagnosticsFetch,
	normalizeCacheDiagnostics,
	sendCacheDiagnosticMessage,
} from "./cache-diagnostics.js";

test("cache diagnostics request sends the beta header and a null seed", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fetchImpl: CacheDiagnosticsFetch = async (url, init) => {
		capturedUrl = String(url);
		capturedInit = init;
		return new Response(
			JSON.stringify({ id: "msg-seed", usage: {}, diagnostics: null }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await sendCacheDiagnosticMessage(
		{
			apiUrl: "https://api.example.test/v1/messages",
			apiKey: "synthetic-key",
			anthropicVersion: "2023-06-01",
			body: { model: "synthetic-model", messages: [] },
			previousMessageId: null,
			timeoutMs: 1000,
		},
		fetchImpl,
	);

	assert.equal(capturedUrl, "https://api.example.test/v1/messages");
	const headers = new Headers(capturedInit?.headers);
	assert.equal(headers.get("anthropic-beta"), CACHE_DIAGNOSTICS_BETA);
	assert.equal(headers.get("x-api-key"), "synthetic-key");
	assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
		model: "synthetic-model",
		messages: [],
		diagnostics: { previous_message_id: null },
	});
	assert.equal(result.id, "msg-seed");
	assert.deepEqual(result.diagnostics, {
		status: "seed",
		cacheMissReason: null,
	});
});

test("cache diagnostics links a later request and normalizes changed-token evidence", async () => {
	const fetchImpl: CacheDiagnosticsFetch = async (_url, init) => {
		assert.equal(
			JSON.parse(String(init?.body)).diagnostics.previous_message_id,
			"msg-previous",
		);
		return new Response(
			JSON.stringify({
				id: "msg-next",
				usage: { input_tokens: 12 },
				diagnostics: {
					cache_miss_reason: {
						type: "tools_changed",
						cache_missed_input_tokens: 321,
					},
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await sendCacheDiagnosticMessage(
		{
			apiUrl: "https://api.example.test/v1/messages",
			apiKey: "synthetic-key",
			anthropicVersion: "2023-06-01",
			body: { model: "synthetic-model", messages: [] },
			previousMessageId: "msg-previous",
			timeoutMs: 1000,
		},
		fetchImpl,
	);

	assert.deepEqual(result.diagnostics, {
		status: "miss",
		cacheMissReason: "tools_changed",
		cacheMissedInputTokens: 321,
	});
});

test("cache diagnostics treats a null top-level diagnostic as a hit", () => {
	assert.deepEqual(normalizeCacheDiagnostics(null, "msg-previous"), {
		status: "hit",
		cacheMissReason: null,
	});
});

test("cache diagnostics treats a pending miss reason as inconclusive", () => {
	assert.deepEqual(
		normalizeCacheDiagnostics({ cache_miss_reason: null }, "msg-previous"),
		{ status: "pending", cacheMissReason: null },
	);
});

test("cache diagnostics treats an absent diagnostic as unavailable", () => {
	assert.deepEqual(normalizeCacheDiagnostics(undefined, "msg-previous"), {
		status: "unavailable",
		cacheMissReason: null,
	});
});

test("cache diagnostics preserves a missing predecessor as unavailable", () => {
	assert.deepEqual(
		normalizeCacheDiagnostics(
			{ cache_miss_reason: { type: "previous_message_not_found" } },
			"msg-previous",
		),
		{
			status: "unavailable",
			cacheMissReason: "previous_message_not_found",
		},
	);
});

test("cache diagnostics preserves an unavailable reason", () => {
	assert.deepEqual(
		normalizeCacheDiagnostics(
			{ cache_miss_reason: { type: "unavailable" } },
			"msg-previous",
		),
		{
			status: "unavailable",
			cacheMissReason: "unavailable",
		},
	);
});

for (const reason of [
	"model_changed",
	"system_changed",
	"tools_changed",
	"messages_changed",
] as const) {
	test(`cache diagnostics treats ${reason} as a cache miss`, () => {
		assert.deepEqual(
			normalizeCacheDiagnostics(
				{ cache_miss_reason: { type: reason } },
				"msg-previous",
			),
			{ status: "miss", cacheMissReason: reason },
		);
	});
}

test("cache diagnostics fails closed on beta schema drift", () => {
	assert.throws(
		() => normalizeCacheDiagnostics({}, "msg-previous"),
		/Malformed cache diagnostics payload/,
	);
	assert.throws(
		() => normalizeCacheDiagnostics("malformed", "msg-previous"),
		/Malformed cache diagnostics payload/,
	);
	assert.throws(
		() =>
			normalizeCacheDiagnostics(
				{ cache_miss_reason: { type: "new_unreviewed_reason" } },
				"msg-previous",
			),
		/Unknown cache diagnostics miss reason/,
	);
	assert.throws(
		() =>
			normalizeCacheDiagnostics(
				{
					cache_miss_reason: {
						type: "messages_changed",
						cache_missed_input_tokens: -1,
					},
				},
				"msg-previous",
			),
		/cache_missed_input_tokens/,
	);
});
