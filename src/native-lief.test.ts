import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	extractClaudeJsFromNativeBinary,
	repackNativeBinary,
} from "./native.js";
import {
	locateLiefBunSection,
	type NativeBunSectionLayout,
	validateNativeBunSectionLayout,
} from "./native-lief.js";

async function hashFileRange(
	filePath: string,
	start: number,
	endExclusive: number,
): Promise<string> {
	const hash = createHash("sha256");
	if (start === endExclusive) return hash.digest("hex");
	const stream = fs.createReadStream(filePath, {
		start,
		end: endExclusive - 1,
	});
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}

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

	test(`${fixture.name} repacks at fixed layout`, async (t) => {
		const target = process.env[fixture.envName];
		if (!target) {
			t.skip(`${fixture.envName} is not set`);
			return;
		}

		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "native-fixed-layout-"),
		);
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const outputPath = path.join(
			directory,
			fixture.format === "PE" ? "patched.exe" : "patched",
		);
		const replacement = Buffer.from(
			'console.log("fixed-layout-native-probe");',
		);
		const cleanSize = fs.statSync(target).size;
		const cleanLayout = locateLiefBunSection(target);

		repackNativeBinary(target, replacement, outputPath);

		assert.equal(fs.statSync(outputPath).size, cleanSize);
		assert.deepEqual(locateLiefBunSection(outputPath), cleanLayout);
		assert.equal(
			await hashFileRange(target, 0, cleanLayout.fileOffset),
			await hashFileRange(outputPath, 0, cleanLayout.fileOffset),
		);
		const sectionEnd = cleanLayout.fileOffset + cleanLayout.fileSize;
		assert.equal(
			await hashFileRange(target, sectionEnd, cleanSize),
			await hashFileRange(outputPath, sectionEnd, cleanSize),
		);
		assert.deepEqual(extractClaudeJsFromNativeBinary(outputPath), replacement);
	});
}
