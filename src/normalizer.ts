import * as prettier from "prettier";

interface NormalizeOptions {
	filepath?: string;
}

export async function normalize(
	code: string,
	opts: NormalizeOptions = {},
): Promise<string> {
	const filepath = opts.filepath ?? "file.js";

	// Infer parser from filepath (babel for .js, typescript for .ts, etc.)
	const fileInfo = await prettier.getFileInfo(filepath);

	// Always format - we never want to skip based on ignore rules
	return prettier.format(code, {
		filepath,
		parser: fileInfo.inferredParser ?? "babel",
		printWidth: 100,
		tabWidth: 2,
		useTabs: false,
		semi: true,
		singleQuote: false,
		trailingComma: "all",
		bracketSpacing: true,
		arrowParens: "always",
	});
}
