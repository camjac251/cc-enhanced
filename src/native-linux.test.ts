import assert from "node:assert/strict";
import { test } from "node:test";
import {
	copyBunCjsEnvelope,
	unwrapBunCjsModule,
	wrapBunCjsModuleBuffer,
} from "./native-linux.js";

test("detached Bun CJS envelope rewraps UTF-8 body bytes exactly", () => {
	const source = [
		"// @bun @bytecode @bun-cjs",
		"(function(exports, require, module, __filename, __dirname){",
		'const greeting = "before";',
		"});",
	].join("\n");
	const wrapper = unwrapBunCjsModule(source);
	assert.ok(wrapper);

	const replacementBody = Buffer.from('\nconst greeting = "こんにちは";\n');
	const envelope = copyBunCjsEnvelope(wrapper);
	const rebuilt = wrapBunCjsModuleBuffer(envelope, replacementBody);
	const expected = Buffer.from(
		`${wrapper.prefix}${replacementBody.toString("utf-8")}${wrapper.suffix}`,
		"utf-8",
	);

	assert.deepEqual(rebuilt, expected);
});
