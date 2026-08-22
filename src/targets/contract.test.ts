import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isNativeArtifactPlatform,
	NATIVE_ARTIFACT_PLATFORMS,
	parseNativeArtifactPlatform,
} from "./contract.js";

test("native artifact platform parsing accepts only official manifest keys", () => {
	for (const platform of NATIVE_ARTIFACT_PLATFORMS) {
		assert.equal(isNativeArtifactPlatform(platform), true);
		assert.equal(parseNativeArtifactPlatform(platform), platform);
	}

	for (const platform of ["windows-x64", "windows-arm64", "plan9-x64", ""]) {
		assert.equal(isNativeArtifactPlatform(platform), false);
		assert.throws(
			() => parseNativeArtifactPlatform(platform),
			/Unsupported native artifact platform/,
		);
	}
});
