import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSelfHostedReadinessPlan,
	createSelfHostedReadinessResult,
} from "../self-hosted/readiness.js";
import { renderSelfHostedReadiness } from "./self-hosted.js";

test("self-hosted presentation separates construction, deployment, and clients", () => {
	const result = createSelfHostedReadinessResult(
		createSelfHostedReadinessPlan(),
	);
	const output = renderSelfHostedReadiness(result).join("\n");

	assert.match(output, /candidate construction:\s+ready/i);
	assert.match(output, /image build:\s+blocked/i);
	assert.match(output, /image receipt:\s+not-bound/i);
	assert.match(output, /deployment:\s+blocked/i);
	assert.match(output, /profile support:\s+blocked.*non-selectable/i);
	assert.match(output, /0 supported; 30 probe-required; 15 excluded/i);
	assert.match(output, /linux and macos.*windows.*linux container/i);
	assert.match(output, /runner-pinned/i);
	assert.match(output, /stdin.*file descriptor 3.*not run/i);
	assert.match(output, /wrapper receipt:\s+not-bound/i);
	assert.match(output, /runner registration:\s+not-run/i);
	assert.match(output, /Web:\s+not-run/i);
	assert.match(output, /Mobile:\s+not-run/i);
	assert.match(output, /Desktop:\s+not-run/i);
	assert.doesNotMatch(output, /fully compatible|production ready/i);
});
