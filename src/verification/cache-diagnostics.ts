export const CACHE_DIAGNOSTICS_BETA = "cache-diagnosis-2026-04-07";

const CACHE_MISS_REASONS = new Set([
	"model_changed",
	"system_changed",
	"tools_changed",
	"messages_changed",
	"previous_message_not_found",
	"unavailable",
]);

export type CacheDiagnosticsFetch = typeof fetch;

export interface NormalizedCacheDiagnostics {
	status: "seed" | "hit" | "pending" | "miss" | "unavailable";
	cacheMissReason: string | null;
	cacheMissedInputTokens?: number;
}

export interface CacheDiagnosticMessageOptions {
	apiUrl: string;
	apiKey: string;
	anthropicVersion: string;
	body: Record<string, unknown>;
	previousMessageId: string | null;
	timeoutMs: number;
}

export interface CacheDiagnosticMessageResult {
	id?: string;
	usage: unknown;
	diagnostics: NormalizedCacheDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCacheDiagnostics(
	value: unknown,
	previousMessageId: string | null,
): NormalizedCacheDiagnostics {
	if (previousMessageId === null) {
		return { status: "seed", cacheMissReason: null };
	}
	if (value === undefined) {
		return { status: "unavailable", cacheMissReason: null };
	}
	if (value === null) {
		return { status: "hit", cacheMissReason: null };
	}
	if (!isRecord(value) || !("cache_miss_reason" in value)) {
		throw new Error("Malformed cache diagnostics payload");
	}
	const reason = value.cache_miss_reason;
	if (reason === null) {
		return { status: "pending", cacheMissReason: null };
	}
	if (!isRecord(reason) || typeof reason.type !== "string") {
		throw new Error("Malformed cache diagnostics miss reason");
	}
	if (!CACHE_MISS_REASONS.has(reason.type)) {
		throw new Error(`Unknown cache diagnostics miss reason: ${reason.type}`);
	}
	if (
		reason.type === "previous_message_not_found" ||
		reason.type === "unavailable"
	) {
		return { status: "unavailable", cacheMissReason: reason.type };
	}
	const missedTokens = reason.cache_missed_input_tokens;
	if (
		missedTokens !== undefined &&
		(typeof missedTokens !== "number" ||
			!Number.isFinite(missedTokens) ||
			missedTokens < 0)
	) {
		throw new Error(
			"Cache diagnostics cache_missed_input_tokens must be a finite non-negative number",
		);
	}
	return {
		status: "miss",
		cacheMissReason: reason.type,
		...(typeof missedTokens === "number"
			? { cacheMissedInputTokens: missedTokens }
			: {}),
	};
}

export async function sendCacheDiagnosticMessage(
	options: CacheDiagnosticMessageOptions,
	fetchImpl: CacheDiagnosticsFetch = fetch,
): Promise<CacheDiagnosticMessageResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetchImpl(options.apiUrl, {
			method: "POST",
			headers: {
				"anthropic-beta": CACHE_DIAGNOSTICS_BETA,
				"anthropic-version": options.anthropicVersion,
				"content-type": "application/json",
				"x-api-key": options.apiKey,
			},
			body: JSON.stringify({
				...options.body,
				diagnostics: {
					previous_message_id: options.previousMessageId,
				},
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Anthropic API ${response.status} ${response.statusText}: ${errorText}`,
			);
		}
		const json = (await response.json()) as Record<string, unknown>;
		return {
			...(typeof json.id === "string" ? { id: json.id } : {}),
			usage: json.usage ?? {},
			diagnostics: normalizeCacheDiagnostics(
				json.diagnostics,
				options.previousMessageId,
			),
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
