import assert from "node:assert/strict";
import { test } from "node:test";
import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import { childNetworkEnv } from "./child-network-env.js";

async function runChildNetworkEnvViaPasses(ast: any): Promise<void> {
	const passes = (await childNetworkEnv.astPasses?.(ast)) ?? [];
	await runCombinedAstPasses(
		ast,
		passes.map((pass) => ({ tag: childNetworkEnv.tag, pass })),
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
}

const CHILD_ENV_FIXTURE = `
let sessionEnv = {};
let toolEnv = {};
function readSessionEnv() { return sessionEnv; }
function isEnabled(value) { return value === "1"; }
function buildRemoteEnv() { return {}; }
function scrubbedKeys() { return []; }
function hasToolEnv() { return false; }
const authKeys = [];
function buildChildEnvironment() {
  let extra = readSessionEnv(),
    hasExtra = Object.keys(extra).length > 0,
    hasToolOverrides = Object.keys(toolEnv).length > 0,
    remote = isEnabled(process.env.CLAUDE_CODE_REMOTE) ? buildRemoteEnv() : {},
    hasRemote = Object.keys(remote).length > 0,
    scrubTools = hasToolEnv(),
    hasAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN !== void 0 ||
      process.env.CLAUDE_CODE_ARTIFACTS_API_TOKEN !== void 0 ||
      process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE !== void 0 ||
      process.env.CLAUDE_CODE_RATE_LIMIT_TIER !== void 0,
    scrubbed = scrubbedKeys(process.env);
  if (!hasExtra && !hasToolOverrides && !hasRemote && !scrubTools && !hasAuth && !scrubbed.length) return process.env;
  let child = { ...process.env, ...toolEnv, ...extra, ...remote };
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  delete child.CLAUDE_CODE_ARTIFACTS_API_TOKEN;
  for (const key of authKeys) delete child[key];
  return child;
}
function allowsMcp() {
  let value = process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;
  return value === "1";
}
function buildNestedClientEnvironment() { return { ...process.env }; }
`;

function evaluatePatched(code: string) {
	const processValue: { env: Record<string, string | undefined> } = {
		env: {},
	};
	const runtime = Function(
		"process",
		`${code}
return {
  setEnv(value) { process.env = value; },
  buildChildEnvironment,
  buildNestedClientEnvironment,
};`,
	)(processValue);
	return runtime as {
		setEnv: (value: Record<string, string | undefined>) => void;
		buildChildEnvironment: () => Record<string, string | undefined>;
		buildNestedClientEnvironment: () => Record<string, string | undefined>;
	};
}

test("verify rejects a bundle without the child environment builder", () => {
	const ast = parse("function unrelated() { return process.env; }");
	assert.equal(typeof childNetworkEnv.verify(print(ast), ast), "string");
});

test("restores the original network environment for child commands", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const output = print(ast);
	const runtime = evaluatePatched(output);
	runtime.setEnv({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		HTTP_PROXY: "http://127.0.0.1:3457",
		https_proxy: "http://127.0.0.1:3457",
		http_proxy: "http://127.0.0.1:3457",
		NO_PROXY: "localhost",
		no_proxy: "localhost",
		NODE_EXTRA_CA_CERTS: "/tmp/local-ca.pem",
		CLODEX_ORIGINAL_NETWORK_ENV: JSON.stringify({
			HTTPS_PROXY: "http://corp-proxy.example:8080",
			NO_PROXY: ".internal.example",
			NODE_EXTRA_CA_CERTS: "/tmp/corporate-ca.pem",
		}),
	});

	assert.deepEqual(runtime.buildChildEnvironment(), {
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://corp-proxy.example:8080",
		NO_PROXY: ".internal.example",
		NODE_EXTRA_CA_CERTS: "/tmp/corporate-ca.pem",
	});
	assert.equal(childNetworkEnv.verify(output, ast), true);
});

test("removes bridge settings when the original environment had none", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setEnv({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		HTTP_PROXY: "http://127.0.0.1:3457",
		https_proxy: "http://127.0.0.1:3457",
		http_proxy: "http://127.0.0.1:3457",
		NO_PROXY: "localhost",
		no_proxy: "localhost",
		NODE_EXTRA_CA_CERTS: "/tmp/local-ca.pem",
		CLODEX_ORIGINAL_NETWORK_ENV: "{}",
	});

	assert.deepEqual(runtime.buildChildEnvironment(), { PATH: "/usr/bin" });
});

test("removes all network routing from direct-mode child commands", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setEnv({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		HTTP_PROXY: "http://127.0.0.1:3457",
		NO_PROXY: "localhost",
		NODE_EXTRA_CA_CERTS: "/tmp/local-ca.pem",
		CLODEX_ORIGINAL_NETWORK_ENV: JSON.stringify({
			HTTPS_PROXY: "http://corp-proxy.example:8080",
		}),
		CLODEX_CHILD_NETWORK_MODE: "direct",
	});

	assert.deepEqual(runtime.buildChildEnvironment(), { PATH: "/usr/bin" });
});

test("routes child commands through only the selected upstream proxy", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	const upstreamProxy = "http://proxy-user:proxy-secret@127.0.0.1:8080/";
	runtime.setEnv({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		HTTP_PROXY: "http://127.0.0.1:3457",
		NO_PROXY: "localhost",
		NODE_EXTRA_CA_CERTS: "/tmp/local-ca.pem",
		CLODEX_ORIGINAL_NETWORK_ENV: JSON.stringify({
			HTTPS_PROXY: "http://corp-proxy.example:8080",
			NO_PROXY: ".internal.example",
		}),
		CLODEX_CHILD_NETWORK_MODE: "upstream",
		CLODEX_CHILD_UPSTREAM_PROXY: upstreamProxy,
	});

	assert.deepEqual(runtime.buildChildEnvironment(), {
		PATH: "/usr/bin",
		HTTPS_PROXY: upstreamProxy,
		HTTP_PROXY: upstreamProxy,
		https_proxy: upstreamProxy,
		http_proxy: upstreamProxy,
	});
});

test("drops a malformed snapshot without breaking child commands", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	runtime.setEnv({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		CLODEX_ORIGINAL_NETWORK_ENV: "not-json",
	});

	assert.deepEqual(runtime.buildChildEnvironment(), {
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
	});
});

test("leaves stock and nested client environments on the parent route", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const runtime = evaluatePatched(print(ast));
	const stockEnv = {
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://proxy.example:8080",
	};
	runtime.setEnv(stockEnv);
	assert.equal(runtime.buildChildEnvironment(), stockEnv);

	const routedEnv = {
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://127.0.0.1:3457",
		CLODEX_ORIGINAL_NETWORK_ENV: "{}",
	};
	runtime.setEnv(routedEnv);
	assert.deepEqual(runtime.buildNestedClientEnvironment(), routedEnv);
});

test("child-network-env is idempotent", async () => {
	const ast = parse(CHILD_ENV_FIXTURE);
	await runChildNetworkEnvViaPasses(ast);
	const once = print(ast);
	await runChildNetworkEnvViaPasses(ast);
	const twice = print(ast);

	assert.equal(twice, once);
	assert.equal(childNetworkEnv.verify(twice, ast), true);
});
