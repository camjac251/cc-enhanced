import * as prettier from "prettier";

export async function normalize(code: string): Promise<string> {
  return prettier.format(code, {
    parser: "babel",
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
