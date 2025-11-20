import * as fs from "fs/promises";
import * as path from "path";

const PATTERNS = [
    // Normalize runner build paths that vary by build ID
    { pat: /\/home\/runner\/code\/tmp\/claude-cli-external-build-\d+/g, repl: "<BUILD_PATH>" },
    // Normalize line-level version header
    { pat: /^(?:\/\/|\/\*)\s*Version:\s*\d+\.\d+\.\d+\s*$/gm, repl: "$1 <VER>" },
    // Normalize inline VERSION fields
    { pat: /(VERSION:\s*)"\d+\.\d+\.\d+"/g, repl: '$1"<VER>"' },
];

export async function normalizeFile(inPath: string, outPath: string) {
    let content = await fs.readFile(inPath, "utf-8");
    
    for (const { pat, repl } of PATTERNS) {
        content = content.replace(pat, repl);
    }
    
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, content, "utf-8");
}
