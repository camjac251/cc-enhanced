export function stringifySummary(report: unknown): string {
	const ancestors: object[] = [];
	const maxStringLength = 200_000;

	try {
		return JSON.stringify(
			report,
			function (key, value) {
				if (key === "ast") return "[omitted: Babel AST]";
				if (typeof value === "bigint") return value.toString();
				if (value instanceof Error) {
					return {
						name: value.name,
						message: value.message,
						stack: value.stack,
					};
				}
				if (typeof value === "string" && value.length > maxStringLength) {
					const truncatedBy = value.length - maxStringLength;
					return `${value.slice(0, maxStringLength)}... [truncated ${truncatedBy} chars]`;
				}
				if (typeof value === "object" && value !== null) {
					while (
						ancestors.length > 0 &&
						ancestors[ancestors.length - 1] !== this
					) {
						ancestors.pop();
					}
					if (ancestors.includes(value)) return "[Circular]";
					ancestors.push(value);
				}
				return value;
			},
			2,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return JSON.stringify(
			{
				error: "Failed to serialize full summary",
				reason,
			},
			null,
			2,
		);
	}
}
