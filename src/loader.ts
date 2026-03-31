import generator, { type GeneratorOptions } from "@babel/generator";
import * as parser from "@babel/parser";
import type * as t from "@babel/types";

type ParseSourceType = "module" | "script";

export interface ParseOptions {
	sourceType?: ParseSourceType;
	fallbackToScript?: boolean;
}

const BASE_PARSE_OPTIONS = {
	plugins: [],
	tokens: false,
} satisfies Omit<parser.ParserOptions, "sourceType">;

const MODULE_PARSE_OPTIONS = {
	...BASE_PARSE_OPTIONS,
	sourceType: "module",
} satisfies parser.ParserOptions;

const SCRIPT_PARSE_OPTIONS = {
	...BASE_PARSE_OPTIONS,
	sourceType: "script",
} satisfies parser.ParserOptions;

const GENERATOR_OPTIONS = {
	retainLines: true,
	compact: false,
} satisfies GeneratorOptions;

function parseWithSourceType(
	code: string,
	sourceType: ParseSourceType,
): t.File {
	return parser.parse(
		code,
		sourceType === "module" ? MODULE_PARSE_OPTIONS : SCRIPT_PARSE_OPTIONS,
	);
}

export function parse(code: string, options: ParseOptions = {}): t.File {
	const sourceType = options.sourceType ?? "module";
	const fallbackToScript = options.fallbackToScript ?? sourceType === "module";

	if (sourceType === "script") {
		return parseWithSourceType(code, "script");
	}

	try {
		return parseWithSourceType(code, "module");
	} catch (moduleError) {
		if (!fallbackToScript) {
			throw moduleError;
		}

		try {
			return parseWithSourceType(code, "script");
		} catch (scriptError) {
			const moduleMessage =
				moduleError instanceof Error
					? moduleError.message
					: String(moduleError);
			const scriptMessage =
				scriptError instanceof Error
					? scriptError.message
					: String(scriptError);
			throw new Error(
				`Failed to parse JavaScript as module or script. Module error: ${moduleMessage}. Script error: ${scriptMessage}.`,
			);
		}
	}
}

export function print(ast: t.Node | t.File): string {
	return generator.default(ast, GENERATOR_OPTIONS).code;
}
