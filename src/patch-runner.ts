import { File } from "@babel/types";
import { PatchReport, PatchRule, initialReport, PatchContext } from "./types.js";
import { parse, print } from "./loader.js";
import { normalize } from "./normalizer.js";
import * as fs from "fs/promises";

export class PatchRunner {
  private rules: PatchRule[] = [];

  addRule(rule: PatchRule) {
    this.rules.push(rule);
  }

  async run(filePath: string, dryRun = false): Promise<PatchReport> {
    let code = await fs.readFile(filePath, "utf-8");
    
    // Normalize first (optional but recommended in PRD)
    // code = await normalize(code); 
    
    console.log(`    Parsing AST (size: ${(code.length / 1024 / 1024).toFixed(2)} MB)...`);
    const ast = parse(code);
    console.log("    AST Parsed.");
    const report: PatchReport = { ...initialReport, locations: {}, detected_variables: {} };
    
    const context: PatchContext = {
      report,
      filePath
    };

    for (const rule of this.rules) {
      console.log(`    running rule: ${rule.name}...`);
      try {
        // rule is a function, but we might need to cast it to access name if it's anonymous? 
        // functions have .name property.
        await rule(ast, context);
      } catch (e) {
         console.error(`    Rule ${rule.name} failed:`, e);
      }
    }

    if (!dryRun) {
      const output = print(ast);
      await fs.writeFile(filePath, output, "utf-8");
    }

    return report;
  }
}
