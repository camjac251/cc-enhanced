declare module "claude-code" {
	interface PluginState {
		"cc-enhanced": {
			planFile: string;
			memoryPaths: { files: string[]; directories: string[] };
		};
	}
}
