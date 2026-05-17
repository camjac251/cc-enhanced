export interface PromptDashStyleCounts {
	enDash: number;
	emDash: number;
	total: number;
}

export interface PromptDashStyleMatch {
	character: "\u2013" | "\u2014";
	index: number;
	label: "en dash" | "em dash";
}

const FORBIDDEN_PROMPT_DASH_RE = /[\u2013\u2014]/;

export function containsForbiddenPromptDashStyle(text: string): boolean {
	return FORBIDDEN_PROMPT_DASH_RE.test(text);
}

export function countForbiddenPromptDashStyle(
	text: string,
): PromptDashStyleCounts {
	let enDash = 0;
	let emDash = 0;
	for (const character of text) {
		if (character === "\u2013") enDash++;
		if (character === "\u2014") emDash++;
	}
	return {
		enDash,
		emDash,
		total: enDash + emDash,
	};
}

export function findForbiddenPromptDashStyle(
	text: string,
): PromptDashStyleMatch | null {
	const index = text.search(FORBIDDEN_PROMPT_DASH_RE);
	if (index === -1) return null;
	const character = text[index] as "\u2013" | "\u2014";
	return {
		character,
		index,
		label: character === "\u2014" ? "em dash" : "en dash",
	};
}
