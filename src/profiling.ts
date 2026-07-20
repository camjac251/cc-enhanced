const MEBIBYTE = 1024 * 1024;

function formatMebibytes(bytes: number): string {
	return `${(bytes / MEBIBYTE).toFixed(1)}MiB`;
}

export function isPatcherProfileEnabled(
	value = process.env.CLAUDE_PATCHER_PROFILE,
): boolean {
	return value === "1" || value === "true";
}

export function formatMemoryCheckpoint(
	checkpoint: string,
	usage: NodeJS.MemoryUsage,
): string {
	return [
		"[profile:memory]",
		`checkpoint=${checkpoint}`,
		`rss=${formatMebibytes(usage.rss)}`,
		`heapUsed=${formatMebibytes(usage.heapUsed)}`,
		`heapTotal=${formatMebibytes(usage.heapTotal)}`,
		`external=${formatMebibytes(usage.external)}`,
		`arrayBuffers=${formatMebibytes(usage.arrayBuffers)}`,
	].join(" ");
}

export function emitMemoryCheckpoint(
	checkpoint: string,
	enabled = isPatcherProfileEnabled(),
	memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
	sink: (line: string) => void = console.error,
): void {
	if (!enabled) return;
	sink(formatMemoryCheckpoint(checkpoint, memoryUsage()));
}
