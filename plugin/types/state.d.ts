declare module "claude-code" {
	interface PluginState {
		"cc-enhanced": {
			planFile: string;
			memoryPaths: { files: string[]; directories: string[] };
			statuslineCache: {
				readTokens: number;
				writeTokens: number;
				readAt?: number;
				writeAt?: number;
				fiveMinuteAt?: number;
				oneHourAt?: number;
				unlabeledAt?: number;
			};
		};
	}
}
