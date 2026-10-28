export interface PromptDashStyleCounts {
	enDash: number;
	emDash: number;
	total: number;
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
