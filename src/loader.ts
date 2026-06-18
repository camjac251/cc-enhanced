import * as parser from "@babel/parser";
import type * as t from "@babel/types";
import { type GeneratorOptions, generator } from "./babel.js";

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
	// retainLines must stay true: turning it off reflows generated output enough
	// to break verifiers that assert on the printed shape (e.g. read-bat's Read
	// prompt examples). The generate cost it adds is not worth that breakage.
	retainLines: true,
	compact: false,
} satisfies GeneratorOptions;

function escapeNonAsciiForBundle(code: string): string {
	let result = "";
	let segmentStart = 0;

	for (let index = 0; index < code.length; index += 1) {
		const codeUnit = code.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			continue;
		}

		result += code.slice(segmentStart, index);

		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < code.length) {
			const nextCodeUnit = code.charCodeAt(index + 1);
			if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
				result += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
				result += `\\u${nextCodeUnit.toString(16).padStart(4, "0")}`;
				index += 1;
				segmentStart = index + 1;
				continue;
			}
		}

		result += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
		segmentStart = index + 1;
	}

	if (!result) {
		return code;
	}

	return result + code.slice(segmentStart);
}

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
	return escapeNonAsciiForBundle(generator(ast, GENERATOR_OPTIONS).code);
}
