import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { extractClaudeJsFromNativeBinary } from "./native.js";
import {
	locateLiefBunSection,
	type NativeBunSectionLayout,
	validateNativeBunSectionLayout,
} from "./native-lief.js";

test("rejects a native section that extends beyond its artifact", () => {
	const layout: NativeBunSectionLayout = {
		format: "PE",
		sectionName: ".bun",
		fileOffset: 80,
		fileSize: 32,
		virtualAddress: 4096n,
		virtualSize: 24n,
		hasCodeSignature: null,
	};

	assert.throws(
		() => validateNativeBunSectionLayout(layout, 100),
		/\.bun range \(80\+32\) exceeds native artifact \(100 bytes\)/,
	);
});

for (const fixture of [
	{
		name: "official PE artifact exposes a bounded .bun section",
		envName: "CC_ENHANCED_TEST_PE_ARTIFACT",
		format: "PE" as const,
		sectionName: ".bun",
	},
	{
		name: "official Mach-O artifact exposes a bounded __BUN/__bun section",
		envName: "CC_ENHANCED_TEST_MACHO_ARTIFACT",
		format: "MachO" as const,
		sectionName: "__bun",
	},
]) {
	test(fixture.name, (t) => {
		const target = process.env[fixture.envName];
		if (!target) {
			t.skip(`${fixture.envName} is not set`);
			return;
		}

		const artifactSize = fs.statSync(target).size;
		const layout = locateLiefBunSection(target);

		assert.equal(layout.format, fixture.format);
		assert.equal(layout.sectionName, fixture.sectionName);
		assert.ok(layout.fileSize > 0);
		assert.ok(layout.fileOffset >= 0);
		assert.ok(layout.fileOffset + layout.fileSize <= artifactSize);
	});

	test(`${fixture.name} yields embedded JavaScript`, (t) => {
		const target = process.env[fixture.envName];
		if (!target) {
			t.skip(`${fixture.envName} is not set`);
			return;
		}

		const source = extractClaudeJsFromNativeBinary(target);
		assert.ok(source.length > 0);
		assert.ok(source.length < fs.statSync(target).size);
	});
}
