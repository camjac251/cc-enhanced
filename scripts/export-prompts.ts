#!/usr/bin/env tsx
/**
 * Export prompt artifacts from a clean/patched claude-code cli.js.
 *
 * Usage:
 *   tsx scripts/export-prompts.ts [version-or-path]
 *
 * Input resolution order:
 * - explicit path to cli.js
 * - versions_clean/<arg>/cli.js
 * - versions_clean/patched/cli.js
 * - latest semver directory under versions_clean/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as parser from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
	buildPromptCorpusDebug,
	buildPromptCorpusIdMap,
	buildPromptDataset,
	buildPromptDatasetFilename,
	buildPromptHashIndex,
	dedupeCorpusByRange,
	isValidPromptText,
	type PromptCorpusEntry,
} from "../src/prompt-corpus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
const versionsDir = path.join(repoRoot, "versions_clean");
const exportRoot = path.join(repoRoot, "exported-prompts");

const SYSTEM_PROMPT_ANCHOR =
	"You are Claude Code, Anthropic's official CLI for Claude.";

type FunctionLikeNode =
	| t.FunctionDeclaration
	| t.FunctionExpression
	| t.ArrowFunctionExpression
	| t.ObjectMethod;

interface ResolvedInput {
	label: string;
	cliPath: string;
}

interface AgentPrompt {
	agentType: string;
	slug: string;
	sourceSymbol: string | null;
	prompt: string;
}

interface SectionPrompt {
	heading: string;
	slug: string;
	sourceSymbol: string | null;
	snippets: string[];
}

interface OutputStyle {
	id: string;
	name: string;
	source: string | null;
	description: string | null;
	keepCodingInstructions: boolean | null;
	prompt: string;
}

interface OutputStylesResult {
	defaultStyle: string | null;
	styles: OutputStyle[];
}

interface BuilderOutline {
	sourceSymbol: string | null;
	alias: string;
	steps: string[];
	anchorPromptSnippet: string | null;
	sectionSymbols: string[];
}

interface ToolPrompt {
	name: string;
	slug: string;
	sourceSymbol: string | null;
	description: string | null;
	prompt: string | null;
	hasInputSchema: boolean;
	hasOutputSchema: boolean;
}

interface SchemaTool {
	name: string;
	slug: string;
	sourceSymbol: string | null;
	title: string | null;
	description: string;
}

interface SystemPromptVariant {
	name: string;
	slug: string;
	text: string;
}

interface RenderContext {
	aliases: Map<string, string>;
	stringBindings: Map<string, string>;
	functionBindings: Map<string, FunctionLikeNode>;
	syntheticByKey: Map<string, string>;
	syntheticCounter: number;
}

function createRenderContext(): RenderContext {
	return {
		aliases: new Map<string, string>(),
		stringBindings: new Map<string, string>(),
		functionBindings: new Map<string, FunctionLikeNode>(),
		syntheticByKey: new Map<string, string>(),
		syntheticCounter: 1,
	};
}

function getSyntheticLabel(
	context: RenderContext,
	key: string,
	prefix: string,
): string {
	const existing = context.syntheticByKey.get(key);
	if (existing) return existing;
	const next = `${prefix}_${context.syntheticCounter++}`;
	context.syntheticByKey.set(key, next);
	return next;
}

function isLikelyMinifiedSymbol(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]{0,2}$/.test(name);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

function compareSemverLike(a: string, b: string): number {
	const parse = (value: string) =>
		value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	const maxLen = Math.max(left.length, right.length);
	for (let index = 0; index < maxLen; index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function resolveInput(rawArg?: string): ResolvedInput {
	if (rawArg) {
		const maybePath = path.resolve(rawArg);
		if (fs.existsSync(maybePath) && fs.statSync(maybePath).isFile()) {
			return {
				label: path.basename(path.dirname(maybePath)),
				cliPath: maybePath,
			};
		}
		const versionPath = path.join(versionsDir, rawArg, "cli.js");
		if (fs.existsSync(versionPath)) {
			return { label: rawArg, cliPath: versionPath };
		}
		throw new Error(
			`Could not resolve input "${rawArg}". Expected an existing cli.js path or versions_clean/<version>/cli.js`,
		);
	}

	const patchedPath = path.join(versionsDir, "patched", "cli.js");
	if (fs.existsSync(patchedPath)) {
		return { label: "patched", cliPath: patchedPath };
	}

	const dirs = fs
		.readdirSync(versionsDir, { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name),
		)
		.map((entry) => entry.name)
		.sort(compareSemverLike);
	if (dirs.length === 0) {
		throw new Error(`No version directories found in ${versionsDir}`);
	}
	const latest = dirs[dirs.length - 1];
	return { label: latest, cliPath: path.join(versionsDir, latest, "cli.js") };
}

function writeArtifact(
	outputDir: string,
	written: string[],
	relativePath: string,
	content: string,
): void {
	const targetPath = path.join(outputDir, relativePath);
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, content);
	written.push(relativePath);
}

function getPropertyName(
	node: t.ObjectProperty | t.ObjectMethod,
): string | null {
	const key = node.key;
	if (t.isIdentifier(key)) return key.name;
	if (t.isStringLiteral(key)) return key.value;
	return null;
}

function getObjectProperty(
	objectNode: t.ObjectExpression,
	name: string,
): t.ObjectProperty | t.ObjectMethod | null {
	for (const prop of objectNode.properties) {
		if (!(t.isObjectProperty(prop) || t.isObjectMethod(prop))) continue;
		if (getPropertyName(prop) === name) return prop;
	}
	return null;
}

function inferAssignedSymbol(
	pathRef: NodePath<t.ObjectExpression>,
): string | null {
	const parentPath = pathRef.parentPath;
	if (
		parentPath?.isVariableDeclarator() &&
		t.isIdentifier(parentPath.node.id)
	) {
		return parentPath.node.id.name;
	}
	if (
		parentPath?.isAssignmentExpression() &&
		t.isIdentifier(parentPath.node.left)
	) {
		return parentPath.node.left.name;
	}
	return null;
}

function getFunctionSymbol(pathRef: NodePath<t.Function>): string | null {
	if (pathRef.isObjectMethod()) {
		const key = pathRef.node.key;
		if (t.isIdentifier(key)) return key.name;
		if (t.isStringLiteral(key)) return key.value;
	}
	if (t.isFunctionDeclaration(pathRef.node) && pathRef.node.id) {
		return pathRef.node.id.name;
	}
	const parentPath = pathRef.parentPath;
	if (
		parentPath?.isVariableDeclarator() &&
		t.isIdentifier(parentPath.node.id)
	) {
		return parentPath.node.id.name;
	}
	if (
		parentPath?.isAssignmentExpression() &&
		t.isIdentifier(parentPath.node.left)
	) {
		return parentPath.node.left.name;
	}
	if (parentPath?.isObjectProperty()) {
		const key = parentPath.node.key;
		if (t.isIdentifier(key)) return key.name;
		if (t.isStringLiteral(key)) return key.value;
	}
	return null;
}

function resolveIdentifierName(name: string, context: RenderContext): string {
	const alias = context.aliases.get(name);
	if (alias) return alias;
	if (isLikelyMinifiedSymbol(name)) {
		return getSyntheticLabel(context, `id:${name}`, "value");
	}
	return name;
}

function renderTemplateLiteralWithResolver(
	template: t.TemplateLiteral,
	context: RenderContext,
	resolveIdentifier: (name: string) => string | null,
): string {
	let result = "";
	for (let index = 0; index < template.quasis.length; index++) {
		const quasi = template.quasis[index];
		result += quasi.value.cooked ?? quasi.value.raw;
		if (index >= template.expressions.length) continue;
		const expression = template.expressions[index];
		if (!t.isExpression(expression)) {
			const key = `tpl:${expression.start ?? "?"}:${expression.end ?? "?"}`;
			result += `\${${getSyntheticLabel(context, key, "expr")}}`;
			continue;
		}
		if (t.isIdentifier(expression)) {
			const resolved = resolveIdentifier(expression.name);
			if (resolved !== null) {
				result += resolved;
				continue;
			}
		}
		if (t.isMemberExpression(expression)) {
			const propertyPart =
				!expression.computed && t.isIdentifier(expression.property)
					? expression.property.name
					: t.isStringLiteral(expression.property)
						? expression.property.value
						: null;
			if (propertyPart === "star") {
				result += "★";
				continue;
			}
			if (propertyPart === "bullet") {
				result += "•";
				continue;
			}
		}
		const rendered = renderPromptExpression(expression, context);
		if (rendered !== null) {
			result += rendered;
			continue;
		}
		const descriptor = describeExpression(expression, context);
		if (descriptor === "★" || descriptor === "•") {
			result += descriptor;
		} else {
			result += `\${${descriptor}}`;
		}
	}
	return result;
}

function collectStringBindings(ast: t.File, context: RenderContext): void {
	const rawBindings = new Map<string, t.Expression>();

	traverse.default(ast, {
		VariableDeclarator(pathRef) {
			if (!t.isIdentifier(pathRef.node.id) || !pathRef.node.init) return;
			const init = pathRef.node.init;
			if (
				t.isStringLiteral(init) ||
				t.isTemplateLiteral(init) ||
				t.isIdentifier(init)
			) {
				rawBindings.set(pathRef.node.id.name, init);
			}
		},
		AssignmentExpression(pathRef) {
			if (!t.isIdentifier(pathRef.node.left)) return;
			const right = pathRef.node.right;
			if (
				t.isStringLiteral(right) ||
				t.isTemplateLiteral(right) ||
				t.isIdentifier(right)
			) {
				rawBindings.set(pathRef.node.left.name, right);
			}
		},
	});

	const resolving = new Set<string>();
	const resolveSymbol = (name: string): string | null => {
		const existing = context.stringBindings.get(name);
		if (existing !== undefined) return existing;
		if (resolving.has(name)) return null;
		const expression = rawBindings.get(name);
		if (!expression) return null;

		resolving.add(name);
		let resolved: string | null = null;
		if (t.isStringLiteral(expression)) {
			resolved = expression.value;
		} else if (t.isTemplateLiteral(expression)) {
			resolved = renderTemplateLiteralWithResolver(
				expression,
				context,
				resolveSymbol,
			);
		} else if (t.isIdentifier(expression)) {
			resolved = resolveSymbol(expression.name);
		}
		resolving.delete(name);

		if (resolved !== null) {
			context.stringBindings.set(name, resolved);
		}
		return resolved;
	};

	for (const symbol of rawBindings.keys()) {
		resolveSymbol(symbol);
	}
}

function collectFunctionBindings(ast: t.File, context: RenderContext): void {
	traverse.default(ast, {
		FunctionDeclaration(pathRef) {
			if (!pathRef.node.id) return;
			context.functionBindings.set(pathRef.node.id.name, pathRef.node);
		},
		VariableDeclarator(pathRef) {
			if (!t.isIdentifier(pathRef.node.id) || !pathRef.node.init) return;
			const init = pathRef.node.init;
			if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
				context.functionBindings.set(pathRef.node.id.name, init);
			}
		},
		AssignmentExpression(pathRef) {
			if (!t.isIdentifier(pathRef.node.left)) return;
			const right = pathRef.node.right;
			if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
				context.functionBindings.set(pathRef.node.left.name, right);
			}
		},
	});
}

function renderPromptExpression(
	expression: t.Expression,
	context: RenderContext,
	seenFunctions = new Set<string>(),
): string | null {
	const direct = renderStringLikeNode(expression, context);
	if (direct !== null) return direct;

	if (t.isAwaitExpression(expression)) {
		return renderPromptExpression(expression.argument, context, seenFunctions);
	}

	if (t.isCallExpression(expression) && expression.arguments.length === 0) {
		// Direct function call: fn()
		if (t.isIdentifier(expression.callee)) {
			const symbol = expression.callee.name;
			if (seenFunctions.has(symbol)) return null;
			const target = context.functionBindings.get(symbol);
			if (!target) return null;
			seenFunctions.add(symbol);
			return extractPromptFromFunctionNode(target, context, seenFunctions);
		}
		// Method call on string-like: `template`.trim(), str.trim()
		if (
			t.isMemberExpression(expression.callee) &&
			!expression.callee.computed &&
			t.isIdentifier(expression.callee.property)
		) {
			const method = expression.callee.property.name;
			if (method === "trim" || method === "trimStart" || method === "trimEnd") {
				const inner = renderPromptExpression(
					expression.callee.object,
					context,
					seenFunctions,
				);
				if (inner !== null) {
					return method === "trimStart"
						? inner.trimStart()
						: method === "trimEnd"
							? inner.trimEnd()
							: inner.trim();
				}
			}
		}
	}

	// Binary string concatenation: str + str
	if (t.isBinaryExpression(expression) && expression.operator === "+") {
		const left = renderPromptExpression(
			expression.left,
			context,
			seenFunctions,
		);
		const right = renderPromptExpression(
			expression.right,
			context,
			seenFunctions,
		);
		if (left !== null && right !== null) return left + right;
		if (left !== null)
			return `${left}\${${describeExpression(expression.right, context)}}`;
		if (right !== null)
			return `\${${describeExpression(expression.left, context)}}${right}`;
	}

	return null;
}

function describeExpression(
	expression: t.Expression,
	context: RenderContext,
): string {
	if (t.isIdentifier(expression)) {
		return resolveIdentifierName(expression.name, context);
	}
	if (t.isStringLiteral(expression)) {
		return JSON.stringify(expression.value);
	}
	if (t.isNumericLiteral(expression)) {
		return `${expression.value}`;
	}
	if (t.isBooleanLiteral(expression)) {
		return expression.value ? "true" : "false";
	}
	if (t.isNullLiteral(expression)) {
		return "null";
	}
	if (t.isTemplateLiteral(expression)) {
		return "template";
	}
	if (t.isMemberExpression(expression)) {
		const objectPart = t.isExpression(expression.object)
			? describeExpression(expression.object, context)
			: "value";
		const propertyPart =
			!expression.computed && t.isIdentifier(expression.property)
				? expression.property.name
				: t.isStringLiteral(expression.property)
					? expression.property.value
					: "key";
		if (propertyPart === "star") return "★";
		if (propertyPart === "bullet") return "•";
		return `${objectPart}.${propertyPart}`;
	}
	if (t.isCallExpression(expression)) {
		const callee =
			t.isExpression(expression.callee) || t.isIdentifier(expression.callee)
				? describeExpression(
						t.isIdentifier(expression.callee)
							? expression.callee
							: expression.callee,
						context,
					)
				: "callable";
		return `${callee}()`;
	}
	if (t.isAwaitExpression(expression)) {
		return `await ${describeExpression(expression.argument, context)}`;
	}
	if (t.isConditionalExpression(expression)) {
		return `conditional(${describeExpression(expression.consequent, context)} | ${describeExpression(expression.alternate, context)})`;
	}
	if (t.isLogicalExpression(expression)) {
		return `${describeExpression(expression.left, context)} ${expression.operator} ${describeExpression(expression.right, context)}`;
	}
	if (t.isUnaryExpression(expression)) {
		return `${expression.operator}${describeExpression(expression.argument, context)}`;
	}
	if (t.isArrayExpression(expression)) {
		return `array(${expression.elements.length})`;
	}
	if (t.isObjectExpression(expression)) {
		return "object";
	}
	const key = `expr:${expression.start ?? "?"}:${expression.end ?? "?"}:${expression.type}`;
	return getSyntheticLabel(context, key, "expr");
}

function renderTemplateLiteral(
	template: t.TemplateLiteral,
	context: RenderContext,
): string {
	return renderTemplateLiteralWithResolver(
		template,
		context,
		(name) => context.stringBindings.get(name) ?? null,
	);
}

function renderStringLikeNode(
	node: t.Expression | t.StringLiteral | t.TemplateLiteral,
	context: RenderContext,
): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (t.isTemplateLiteral(node)) return renderTemplateLiteral(node, context);
	if (t.isIdentifier(node)) {
		return context.stringBindings.get(node.name) ?? null;
	}
	return null;
}

function renderReturnedArray(
	array: t.ArrayExpression,
	context: RenderContext,
): string | null {
	const lines: string[] = [];
	for (const element of array.elements) {
		if (!element) continue;
		if (t.isSpreadElement(element)) {
			if (t.isExpression(element.argument)) {
				lines.push(`\${...${describeExpression(element.argument, context)}}`);
			}
			continue;
		}
		if (!t.isExpression(element)) continue;
		const rendered = renderStringLikeNode(element, context);
		if (rendered) {
			lines.push(rendered);
			continue;
		}
		lines.push(`\${${describeExpression(element, context)}}`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

function collectLocalBindings(body: t.Statement[]): Map<string, t.Expression> {
	const bindings = new Map<string, t.Expression>();
	for (const stmt of body) {
		if (!t.isVariableDeclaration(stmt)) continue;
		for (const decl of stmt.declarations) {
			if (t.isIdentifier(decl.id) && decl.init) {
				bindings.set(decl.id.name, decl.init);
			}
		}
	}
	return bindings;
}

function withLocalBindings(
	context: RenderContext,
	localExprs: Map<string, t.Expression>,
	seenFunctions: Set<string>,
	fn: () => string | null,
): string | null {
	const saved = new Map<string, string | undefined>();
	for (const [name, expr] of localExprs) {
		saved.set(name, context.stringBindings.get(name));
		const resolved = renderPromptExpression(
			expr,
			context,
			new Set(seenFunctions),
		);
		if (resolved !== null) {
			context.stringBindings.set(name, resolved);
		}
	}
	try {
		return fn();
	} finally {
		for (const [name, original] of saved) {
			if (original === undefined) {
				context.stringBindings.delete(name);
			} else {
				context.stringBindings.set(name, original);
			}
		}
	}
}

function extractPromptFromFunctionNode(
	node: FunctionLikeNode,
	context: RenderContext,
	seenFunctions = new Set<string>(),
): string | null {
	if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
		return renderPromptExpression(node.body, context, seenFunctions);
	}
	if (!t.isBlockStatement(node.body)) return null;
	const localExprs = collectLocalBindings(node.body.body);
	return withLocalBindings(context, localExprs, seenFunctions, () => {
		for (const statement of node.body.body) {
			if (!t.isReturnStatement(statement) || !statement.argument) continue;
			const direct = renderPromptExpression(
				statement.argument as t.Expression,
				context,
				seenFunctions,
			);
			if (direct) return direct;
			const returnedArray = getArrayFromReturnExpression(statement.argument);
			if (returnedArray) {
				const renderedArray = renderReturnedArray(returnedArray, context);
				if (renderedArray) return renderedArray;
			}
		}
		return null;
	});
}

function getArrayFromReturnExpression(
	expression: t.Expression,
): t.ArrayExpression | null {
	if (t.isArrayExpression(expression)) return expression;
	if (
		t.isCallExpression(expression) &&
		t.isMemberExpression(expression.callee) &&
		t.isIdentifier(expression.callee.property) &&
		expression.callee.property.name === "join" &&
		t.isArrayExpression(expression.callee.object)
	) {
		return expression.callee.object;
	}
	if (
		t.isCallExpression(expression) &&
		t.isMemberExpression(expression.callee) &&
		t.isIdentifier(expression.callee.property) &&
		expression.callee.property.name === "filter" &&
		t.isArrayExpression(expression.callee.object)
	) {
		return expression.callee.object;
	}
	return null;
}

function getHeadingFromString(value: string): string | null {
	const line = value
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith("# "));
	return line ?? null;
}

function normalizeHeading(heading: string): string {
	return heading
		.replace(/\$\{[^}]+\}/g, "{dynamic}")
		.replace(/\s+/g, " ")
		.trim();
}

function isExcludedSectionHeading(normalizedHeading: string): boolean {
	const heading = normalizedHeading.toLowerCase();
	return (
		heading.startsWith("# batch:") ||
		heading.startsWith("# claude in chrome browser automation") ||
		heading.startsWith("# committing changes with git") ||
		heading.startsWith("# first, create/clear the snapshot file") ||
		heading.startsWith("# npm view ") ||
		heading.startsWith("# /") ||
		heading === "# instructions" ||
		heading === "# user's current configuration" ||
		heading === "# session title"
	);
}

function extractHeadingFromExpression(
	expression: t.Expression,
	context: RenderContext,
): string | null {
	const direct = renderPromptExpression(expression, context);
	if (direct) return getHeadingFromString(direct);
	const returnedArray = getArrayFromReturnExpression(expression);
	if (!returnedArray || returnedArray.elements.length === 0) return null;
	const firstElement = returnedArray.elements.find((entry) => entry !== null);
	if (
		!firstElement ||
		t.isSpreadElement(firstElement) ||
		!t.isExpression(firstElement)
	) {
		return null;
	}
	const rendered = renderPromptExpression(firstElement, context);
	if (!rendered) return null;
	return getHeadingFromString(rendered);
}

function extractHeadingFromFunction(
	pathRef: NodePath<t.Function>,
	context: RenderContext,
): string | null {
	if (
		t.isArrowFunctionExpression(pathRef.node) &&
		!t.isBlockStatement(pathRef.node.body)
	) {
		const direct = renderPromptExpression(pathRef.node.body, context);
		return direct ? getHeadingFromString(direct) : null;
	}
	if (!t.isBlockStatement(pathRef.node.body)) return null;
	let heading: string | null = null;
	pathRef.traverse({
		Function(inner) {
			if (inner !== pathRef) inner.skip();
		},
		ReturnStatement(inner) {
			if (
				heading ||
				!inner.node.argument ||
				!t.isExpression(inner.node.argument)
			)
				return;
			heading = extractHeadingFromExpression(inner.node.argument, context);
			if (heading) inner.stop();
		},
	});
	return heading;
}

function isPromptSnippet(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 30) return false;
	if (!/[A-Za-z]/.test(trimmed)) return false;
	if (!/\s/.test(trimmed)) return false;
	return true;
}

function collectPromptSnippetsFromFunction(
	pathRef: NodePath<t.Function>,
	context: RenderContext,
): string[] {
	const snippets = new Map<string, string>();
	pathRef.traverse({
		Function(inner) {
			if (inner !== pathRef) inner.skip();
		},
		StringLiteral(inner) {
			const value = inner.node.value.trim();
			if (isPromptSnippet(value)) snippets.set(value, value);
		},
		TemplateLiteral(inner) {
			const value = renderTemplateLiteral(inner.node, context).trim();
			if (isPromptSnippet(value)) snippets.set(value, value);
		},
	});
	return [...snippets.values()];
}

function isValidAgentType(value: string): boolean {
	if (value.includes("${")) return false;
	if (value.length > 80) return false;
	if (/\s/.test(value)) return false;
	return /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(value);
}

function extractAgentType(
	property: t.ObjectProperty | t.ObjectMethod,
	context: RenderContext,
): string | null {
	if (!t.isObjectProperty(property)) return null;
	if (!t.isExpression(property.value)) return null;
	const rendered = renderStringLikeNode(property.value, context);
	if (!rendered) return null;
	const trimmed = rendered.trim();
	if (!trimmed || !isValidAgentType(trimmed)) return null;
	return trimmed;
}

function getFunctionFromPromptProperty(
	property: t.ObjectProperty | t.ObjectMethod,
	context?: RenderContext,
): FunctionLikeNode | null {
	if (t.isObjectMethod(property)) return property;
	if (!t.isObjectProperty(property)) return null;
	if (
		t.isFunctionExpression(property.value) ||
		t.isArrowFunctionExpression(property.value)
	) {
		return property.value;
	}
	if (t.isIdentifier(property.value) && context) {
		return context.functionBindings.get(property.value.name) ?? null;
	}
	return null;
}

function extractPropertyText(
	property: t.ObjectProperty | t.ObjectMethod,
	context: RenderContext,
): string | null {
	const functionNode = getFunctionFromPromptProperty(property, context);
	if (functionNode) return extractPromptFromFunctionNode(functionNode, context);
	if (!t.isObjectProperty(property) || !t.isExpression(property.value))
		return null;
	return renderPromptExpression(property.value, context);
}

function createUniqueSlug(base: string, seen: Set<string>): string {
	let candidate = base;
	let suffix = 2;
	while (seen.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	seen.add(candidate);
	return candidate;
}

function isLikelyToolName(name: string): boolean {
	return /^[A-Za-z0-9_-]{2,80}$/.test(name);
}

function collectBuiltInTools(
	ast: t.File,
	context: RenderContext,
): ToolPrompt[] {
	const byName = new Map<string, ToolPrompt>();
	const usedSlugs = new Set<string>();

	traverse.default(ast, {
		ObjectExpression(pathRef) {
			const nameProp = getObjectProperty(pathRef.node, "name");
			const promptProp = getObjectProperty(pathRef.node, "prompt");
			const inputSchemaProp =
				getObjectProperty(pathRef.node, "inputSchema") ??
				getObjectProperty(pathRef.node, "input_schema");
			if (!nameProp || !promptProp || !inputSchemaProp) return;

			const name = extractPropertyText(nameProp, context)?.trim();
			if (!name || !isLikelyToolName(name)) return;

			const prompt = extractPropertyText(promptProp, context)?.trim();
			const descriptionProp = getObjectProperty(pathRef.node, "description");
			const description = descriptionProp
				? (extractPropertyText(descriptionProp, context)?.trim() ?? null)
				: null;
			const outputSchemaProp =
				getObjectProperty(pathRef.node, "outputSchema") ??
				getObjectProperty(pathRef.node, "output_schema");
			const sourceSymbol = inferAssignedSymbol(pathRef);
			const existing = byName.get(name);

			const candidate: ToolPrompt = {
				name,
				slug: existing?.slug ?? createUniqueSlug(slugify(name), usedSlugs),
				sourceSymbol,
				description,
				prompt: prompt || null,
				hasInputSchema: !!inputSchemaProp,
				hasOutputSchema: !!outputSchemaProp,
			};

			const candidatePromptLength = candidate.prompt?.length ?? 0;
			const existingPromptLength = existing?.prompt?.length ?? 0;
			const candidateDescriptionLength = candidate.description?.length ?? 0;
			const existingDescriptionLength = existing?.description?.length ?? 0;
			if (
				!existing ||
				candidatePromptLength > existingPromptLength ||
				(candidatePromptLength === existingPromptLength &&
					candidateDescriptionLength > existingDescriptionLength)
			) {
				byName.set(name, candidate);
			}
		},
	});

	return [...byName.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

function collectSchemaTools(
	ast: t.File,
	context: RenderContext,
	excludedNames: Set<string>,
): SchemaTool[] {
	const byName = new Map<string, SchemaTool>();
	const usedSlugs = new Set<string>();

	traverse.default(ast, {
		ObjectExpression(pathRef) {
			const nameProp = getObjectProperty(pathRef.node, "name");
			const descriptionProp = getObjectProperty(pathRef.node, "description");
			const promptProp = getObjectProperty(pathRef.node, "prompt");
			const inputSchemaProp =
				getObjectProperty(pathRef.node, "inputSchema") ??
				getObjectProperty(pathRef.node, "input_schema");
			if (!nameProp || !descriptionProp || !inputSchemaProp || promptProp)
				return;

			const name = extractPropertyText(nameProp, context)?.trim();
			if (!name || !isLikelyToolName(name) || excludedNames.has(name)) return;

			const description = extractPropertyText(descriptionProp, context)?.trim();
			if (!description || description.length < 20) return;

			const titleProp = getObjectProperty(pathRef.node, "title");
			const title = titleProp
				? (extractPropertyText(titleProp, context)?.trim() ?? null)
				: null;
			const sourceSymbol = inferAssignedSymbol(pathRef);
			const existing = byName.get(name);
			const candidate: SchemaTool = {
				name,
				slug: existing?.slug ?? createUniqueSlug(slugify(name), usedSlugs),
				sourceSymbol,
				title,
				description,
			};

			if (
				!existing ||
				candidate.description.length > existing.description.length
			) {
				byName.set(name, candidate);
			}
		},
	});

	return [...byName.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

function collectAgentPrompts(
	ast: t.File,
	context: RenderContext,
): AgentPrompt[] {
	const byType = new Map<string, AgentPrompt>();
	traverse.default(ast, {
		ObjectExpression(pathRef) {
			const agentTypeProp = getObjectProperty(pathRef.node, "agentType");
			const getPromptProp = getObjectProperty(pathRef.node, "getSystemPrompt");
			if (!agentTypeProp || !getPromptProp) return;

			const agentType = extractAgentType(agentTypeProp, context);
			if (!agentType) return;

			const sourceSymbol = inferAssignedSymbol(pathRef);
			const slug = slugify(agentType);
			if (sourceSymbol) {
				context.aliases.set(sourceSymbol, `agent.${slug}`);
			}

			const promptFunction = getFunctionFromPromptProperty(
				getPromptProp,
				context,
			);
			if (!promptFunction) return;
			const prompt = extractPromptFromFunctionNode(promptFunction, context);
			if (!prompt || prompt.trim().length < 50) return;

			byType.set(agentType, {
				agentType,
				slug,
				sourceSymbol,
				prompt: prompt.trim(),
			});
		},
	});
	return [...byType.values()].sort((left, right) =>
		left.agentType.localeCompare(right.agentType),
	);
}

function collectSectionPrompts(
	ast: t.File,
	context: RenderContext,
	allowedSymbols?: Set<string>,
): SectionPrompt[] {
	const bySlug = new Map<string, SectionPrompt>();
	traverse.default(ast, {
		Function(pathRef) {
			const sourceSymbol = getFunctionSymbol(pathRef);
			if (
				allowedSymbols &&
				(!sourceSymbol || !allowedSymbols.has(sourceSymbol))
			) {
				return;
			}
			const heading = extractHeadingFromFunction(pathRef, context);
			if (!heading) return;
			const normalizedHeading = normalizeHeading(heading);
			if (/^#\s*value_\d+$/i.test(normalizedHeading)) return;
			if (isExcludedSectionHeading(normalizedHeading)) return;
			const slug = slugify(normalizedHeading.replace(/^#\s*/, ""));
			if (sourceSymbol) {
				context.aliases.set(sourceSymbol, `section.${slug}`);
			}

			const snippets = collectPromptSnippetsFromFunction(pathRef, context);
			if (snippets.length === 0) return;
			const existing = bySlug.get(slug);
			if (!existing || snippets.length > existing.snippets.length) {
				bySlug.set(slug, {
					heading: normalizedHeading,
					slug,
					sourceSymbol,
					snippets,
				});
			}
		},
	});
	return [...bySlug.values()].sort((left, right) =>
		left.heading.localeCompare(right.heading),
	);
}

function extractOutputStylesFromObject(
	node: t.ObjectExpression,
	context: RenderContext,
): OutputStylesResult | null {
	let defaultStyle: string | null = null;
	const styles: OutputStyle[] = [];

	for (const prop of node.properties) {
		if (!t.isObjectProperty(prop)) continue;
		const keyName = t.isIdentifier(prop.key)
			? prop.key.name
			: t.isStringLiteral(prop.key)
				? prop.key.value
				: null;
		if (!keyName) continue;

		if (keyName === "default") {
			if (t.isStringLiteral(prop.value)) defaultStyle = prop.value.value;
			else if (t.isNullLiteral(prop.value)) defaultStyle = null;
			continue;
		}

		if (!t.isObjectExpression(prop.value)) continue;
		const styleObject = prop.value;
		const nameProp = getObjectProperty(styleObject, "name");
		const promptProp = getObjectProperty(styleObject, "prompt");
		if (
			!nameProp ||
			!promptProp ||
			!t.isObjectProperty(nameProp) ||
			!t.isObjectProperty(promptProp)
		) {
			continue;
		}
		if (!t.isExpression(nameProp.value) || !t.isExpression(promptProp.value))
			continue;
		const styleName = renderStringLikeNode(nameProp.value, context);
		const stylePrompt = renderStringLikeNode(promptProp.value, context);
		if (!styleName || !stylePrompt) continue;

		const sourceProp = getObjectProperty(styleObject, "source");
		const descriptionProp = getObjectProperty(styleObject, "description");
		const keepCodingProp = getObjectProperty(
			styleObject,
			"keepCodingInstructions",
		);

		let source: string | null = null;
		if (
			sourceProp &&
			t.isObjectProperty(sourceProp) &&
			t.isExpression(sourceProp.value)
		) {
			source = renderStringLikeNode(sourceProp.value, context);
		}

		let description: string | null = null;
		if (
			descriptionProp &&
			t.isObjectProperty(descriptionProp) &&
			t.isExpression(descriptionProp.value)
		) {
			description = renderStringLikeNode(descriptionProp.value, context);
		}

		let keepCodingInstructions: boolean | null = null;
		if (
			keepCodingProp &&
			t.isObjectProperty(keepCodingProp) &&
			t.isBooleanLiteral(keepCodingProp.value)
		) {
			keepCodingInstructions = keepCodingProp.value.value;
		} else if (
			keepCodingProp &&
			t.isObjectProperty(keepCodingProp) &&
			t.isUnaryExpression(keepCodingProp.value) &&
			keepCodingProp.value.operator === "!" &&
			t.isNumericLiteral(keepCodingProp.value.argument)
		) {
			keepCodingInstructions = keepCodingProp.value.argument.value === 0;
		}

		styles.push({
			id: keyName,
			name: styleName,
			source,
			description,
			keepCodingInstructions,
			prompt: stylePrompt.trim(),
		});
	}

	if (styles.length < 2) return null;
	return { defaultStyle, styles };
}

function collectOutputStyles(
	ast: t.File,
	context: RenderContext,
): OutputStylesResult | null {
	let best: OutputStylesResult | null = null;
	traverse.default(ast, {
		ObjectExpression(pathRef) {
			const candidate = extractOutputStylesFromObject(pathRef.node, context);
			if (!candidate) return;
			if (!best || candidate.styles.length > best.styles.length) {
				best = candidate;
			}
		},
	});
	return best;
}

function prettifyBuilderStep(step: string, index: number): string {
	if (/^value_\d+\(\)$/.test(step)) {
		return `runtime.fragment_${index + 1}()`;
	}
	if (/^value_\d+$/.test(step)) {
		return `runtime.fragment_${index + 1}`;
	}
	if (step.startsWith("...value_")) {
		return "...runtime.dynamic_sections";
	}
	return step;
}

function normalizeAnchorSnippet(snippet: string | null): string | null {
	if (!snippet) return null;
	return snippet
		.replace(/CWD:\s*\$\{[^}]+\}/g, "CWD: ${cwd()}")
		.replace(/Date:\s*\$\{[^}]+\}/g, "Date: ${current_date()}");
}

function collectPromptCorpus(
	ast: t.File,
	context: RenderContext,
): PromptCorpusEntry[] {
	const candidates: PromptCorpusEntry[] = [];

	traverse.default(ast, {
		StringLiteral(pathRef) {
			const text = pathRef.node.value;
			if (!isValidPromptText(text)) return;
			candidates.push({
				kind: "string",
				text,
				pieces: [text],
				placeholderExpressions: [],
				start: pathRef.node.start ?? 0,
				end: pathRef.node.end ?? 0,
			});
		},
		TemplateLiteral(pathRef) {
			const text = renderTemplateLiteral(pathRef.node, context);
			if (!isValidPromptText(text)) return;

			const pieces = pathRef.node.quasis.map(
				(quasi) => quasi.value.cooked ?? quasi.value.raw,
			);
			const placeholderExpressions = pathRef.node.expressions.map(
				(expression) => {
					if (t.isExpression(expression)) {
						return describeExpression(expression, context);
					}
					return "expression";
				},
			);

			candidates.push({
				kind: "template",
				text,
				pieces,
				placeholderExpressions,
				start: pathRef.node.start ?? 0,
				end: pathRef.node.end ?? 0,
			});
		},
	});

	return dedupeCorpusByRange(candidates);
}

function collectSystemPromptVariants(
	debugCorpus: Array<{ text: string }>,
	context: RenderContext,
	ast: t.File,
): SystemPromptVariant[] {
	const starters = [
		"You are Claude Code",
		"You are a Claude agent",
		"You are an interactive agent",
		"You are the Claude guide agent",
		"You are an agent for Claude Code",
	];
	const byText = new Map<string, SystemPromptVariant>();
	const usedSlugs = new Set<string>();
	const usedNames = new Set<string>();
	const addVariant = (rawText: string): void => {
		const text = rawText.trim();
		if (!text) return;
		if (!starters.some((starter) => text.startsWith(starter))) return;
		if (byText.has(text)) return;

		const firstSentence = text.split("\n")[0]?.trim() ?? "system-prompt";
		let name = firstSentence;
		if (text.includes("CWD:") || text.includes("Date:")) {
			name = `${firstSentence} (Simple Mode)`;
		}
		let uniqueName = name;
		let suffix = 2;
		while (usedNames.has(uniqueName)) {
			uniqueName = `${name} (${suffix})`;
			suffix += 1;
		}
		usedNames.add(uniqueName);
		const baseSlug = slugify(uniqueName.slice(0, 80) || "system-prompt");
		const slug = createUniqueSlug(baseSlug, usedSlugs);
		byText.set(text, {
			name: uniqueName,
			slug,
			text,
		});
	};

	for (const entry of debugCorpus) {
		addVariant(entry.text);
	}
	for (const text of context.stringBindings.values()) {
		addVariant(text);
	}
	traverse.default(ast, {
		Function(pathRef) {
			for (const snippet of collectPromptSnippetsFromFunction(
				pathRef,
				context,
			)) {
				addVariant(snippet);
			}
		},
	});

	return [...byText.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

function collectFunctionPromptSnippets(
	pathRef: NodePath<t.Function>,
	context: RenderContext,
): string[] {
	const snippets = collectPromptSnippetsFromFunction(pathRef, context);
	return snippets.filter(
		(value) => value.includes("Claude") || value.includes("# "),
	);
}

function addSectionSymbolFromExpression(
	expression: t.Expression,
	sectionSymbols: Set<string>,
): void {
	if (t.isIdentifier(expression)) {
		sectionSymbols.add(expression.name);
		return;
	}
	if (t.isCallExpression(expression) && t.isIdentifier(expression.callee)) {
		sectionSymbols.add(expression.callee.name);
		return;
	}
	if (t.isAwaitExpression(expression)) {
		addSectionSymbolFromExpression(expression.argument, sectionSymbols);
	}
}

function extractBuilderOutline(
	ast: t.File,
	context: RenderContext,
): BuilderOutline | null {
	let best: {
		pathRef: NodePath<t.Function>;
		score: number;
	} | null = null;

	traverse.default(ast, {
		Function(pathRef) {
			const snippets = collectFunctionPromptSnippets(pathRef, context);
			const containsAnchor = snippets.some((snippet) =>
				snippet.includes(SYSTEM_PROMPT_ANCHOR),
			);
			if (!containsAnchor) return;
			const source =
				pathRef.node.start !== null && pathRef.node.end !== null
					? pathRef.node.end - pathRef.node.start
					: 0;
			const hasSimpleGuard = snippets.some((snippet) =>
				snippet.includes("CWD:"),
			);
			const score = source + (hasSimpleGuard ? 1_000_000 : 0);
			if (!best || score > best.score) {
				best = { pathRef, score };
			}
		},
	});

	if (!best) return null;

	const sourceSymbol = getFunctionSymbol(best.pathRef);
	const alias =
		sourceSymbol && !isLikelyMinifiedSymbol(sourceSymbol)
			? resolveIdentifierName(sourceSymbol, context)
			: "system.builder";
	if (sourceSymbol) {
		context.aliases.set(sourceSymbol, alias);
	}
	const returnArrays: t.ArrayExpression[] = [];

	if (
		t.isArrowFunctionExpression(best.pathRef.node) &&
		!t.isBlockStatement(best.pathRef.node.body)
	) {
		const array = getArrayFromReturnExpression(best.pathRef.node.body);
		if (array) returnArrays.push(array);
	}
	if (t.isBlockStatement(best.pathRef.node.body)) {
		for (const statement of best.pathRef.node.body.body) {
			if (!t.isReturnStatement(statement) || !statement.argument) continue;
			const array = getArrayFromReturnExpression(statement.argument);
			if (array) returnArrays.push(array);
		}
	}

	const chosenArray = returnArrays.sort(
		(left, right) => right.elements.length - left.elements.length,
	)[0];
	const steps: string[] = [];
	const sectionSymbols = new Set<string>();
	if (chosenArray) {
		for (const [index, element] of chosenArray.elements.entries()) {
			if (!element) continue;
			if (t.isSpreadElement(element)) {
				if (t.isExpression(element.argument)) {
					addSectionSymbolFromExpression(element.argument, sectionSymbols);
					const step = `...${describeExpression(element.argument, context)}`;
					steps.push(prettifyBuilderStep(step, index));
				}
				continue;
			}
			if (!t.isExpression(element)) continue;
			addSectionSymbolFromExpression(element, sectionSymbols);
			const direct = renderStringLikeNode(element, context);
			if (direct) {
				const heading = getHeadingFromString(direct);
				const step = heading ? heading : direct.split("\n")[0].trim();
				steps.push(prettifyBuilderStep(step, index));
				continue;
			}
			const step = describeExpression(element, context);
			steps.push(prettifyBuilderStep(step, index));
		}
	}

	const snippets = collectFunctionPromptSnippets(best.pathRef, context);
	const anchorPromptSnippet = normalizeAnchorSnippet(
		snippets.find((snippet) => snippet.includes(SYSTEM_PROMPT_ANCHOR)) ?? null,
	);

	return {
		sourceSymbol,
		alias,
		steps,
		anchorPromptSnippet,
		sectionSymbols: [...sectionSymbols],
	};
}

function main(): void {
	try {
		const resolved = resolveInput(process.argv[2]);
		const code = fs.readFileSync(resolved.cliPath, "utf-8");
		const outputDir = path.join(exportRoot, resolved.label);
		const written: string[] = [];
		const context = createRenderContext();

		const ast = parser.parse(code, {
			sourceType: "module",
			plugins: [],
			tokens: false,
		});

		collectStringBindings(ast, context);
		collectFunctionBindings(ast, context);
		const agents = collectAgentPrompts(ast, context);
		const outputStyles = collectOutputStyles(ast, context);
		const builtInTools = collectBuiltInTools(ast, context);
		const schemaTools = collectSchemaTools(
			ast,
			context,
			new Set(builtInTools.map((tool) => tool.name)),
		);
		const builder = extractBuilderOutline(ast, context);
		const sections = collectSectionPrompts(ast, context);
		const promptCorpus = collectPromptCorpus(ast, context);
		const promptCorpusIdMap = buildPromptCorpusIdMap(promptCorpus);
		const promptDataset = buildPromptDataset(resolved.label, promptCorpus);
		const promptHashIndex = buildPromptHashIndex(
			resolved.label,
			promptDataset,
			promptCorpusIdMap,
		);
		const promptCorpusDebug = buildPromptCorpusDebug(
			promptDataset,
			promptCorpusIdMap,
		);
		const systemVariants = collectSystemPromptVariants(
			promptCorpusDebug,
			context,
			ast,
		);

		fs.rmSync(outputDir, { recursive: true, force: true });
		fs.mkdirSync(outputDir, { recursive: true });

		for (const agent of agents) {
			const content = [
				`# Agent: ${agent.agentType}`,
				``,
				`- runtime_name: ${agent.agentType}`,
				`- source_symbol: ${agent.sourceSymbol ?? "unknown"}`,
				``,
				agent.prompt,
			].join("\n");
			writeArtifact(
				outputDir,
				written,
				path.join("agents", `${agent.slug}.md`),
				content,
			);
		}
		writeArtifact(
			outputDir,
			written,
			"agents.json",
			`${JSON.stringify(agents, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			path.join("agents", "README.md"),
			[
				"# Built-in Agents",
				"",
				...agents.map(
					(agent, index) =>
						`${index + 1}. [${agent.agentType}](./${agent.slug}.md)`,
				),
			].join("\n"),
		);

		for (const section of sections) {
			const content = [
				section.heading,
				``,
				`- runtime_name: section.${section.slug}`,
				`- source_symbol: ${section.sourceSymbol ?? "unknown"}`,
				``,
				...section.snippets,
			].join("\n\n");
			writeArtifact(
				outputDir,
				written,
				path.join("system", "sections", `${section.slug}.md`),
				content,
			);
		}
		writeArtifact(
			outputDir,
			written,
			path.join("system", "sections.json"),
			`${JSON.stringify(sections, null, 2)}\n`,
		);

		if (builder) {
			const outline = [
				`# System Prompt Builder`,
				``,
				`- runtime_alias: ${builder.alias}`,
				`- source_symbol: ${builder.sourceSymbol ?? "unknown"}`,
				``,
				`## Assembly steps`,
				...builder.steps.map((step, index) => `${index + 1}. ${step}`),
				``,
				`## Anchor snippet`,
				builder.anchorPromptSnippet ?? "(not found)",
			].join("\n");
			writeArtifact(
				outputDir,
				written,
				path.join("system", "builder-outline.md"),
				outline,
			);
		}
		for (const variant of systemVariants) {
			writeArtifact(
				outputDir,
				written,
				path.join("system", "variants", `${variant.slug}.md`),
				[`# ${variant.name}`, "", variant.text].join("\n"),
			);
		}
		writeArtifact(
			outputDir,
			written,
			path.join("system", "system-prompts.json"),
			`${JSON.stringify(systemVariants, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			path.join("system", "README.md"),
			[
				"# System Prompt Artifacts",
				"",
				`- Variants: ${systemVariants.length}`,
				`- Sections: ${sections.length}`,
				`- Builder outline: ${builder ? "present" : "missing"}`,
				"",
				"## Variants",
				...systemVariants.map(
					(variant, index) =>
						`${index + 1}. [${variant.name}](./variants/${variant.slug}.md)`,
				),
				"",
				"## Sections",
				...sections.map(
					(section, index) =>
						`${index + 1}. [${section.heading}](./sections/${section.slug}.md)`,
				),
				"",
				`## Builder`,
				builder
					? "- [System Prompt Builder](./builder-outline.md)"
					: "- Builder outline was not detected.",
			].join("\n"),
		);

		for (const tool of builtInTools) {
			const content = [
				`# Tool: ${tool.name}`,
				"",
				`- source_symbol: ${tool.sourceSymbol ?? "unknown"}`,
				`- has_input_schema: ${tool.hasInputSchema}`,
				`- has_output_schema: ${tool.hasOutputSchema}`,
			];
			if (tool.description) {
				content.push("", "## Description", "", tool.description);
			}
			if (tool.prompt) {
				content.push("", "## Prompt", "", tool.prompt);
			} else {
				content.push(
					"",
					"## Prompt",
					"",
					"(Dynamic prompt: not statically resolved from cli.js AST.)",
				);
			}
			writeArtifact(
				outputDir,
				written,
				path.join("tools", "builtin", `${tool.slug}.md`),
				content.join("\n"),
			);
		}
		for (const tool of schemaTools) {
			const content = [
				`# Schema Tool: ${tool.name}`,
				"",
				`- source_symbol: ${tool.sourceSymbol ?? "unknown"}`,
				`- title: ${tool.title ?? "none"}`,
				"",
				tool.description,
			];
			writeArtifact(
				outputDir,
				written,
				path.join("tools", "schemas", `${tool.slug}.md`),
				content.join("\n"),
			);
		}
		writeArtifact(
			outputDir,
			written,
			"tools.json",
			`${JSON.stringify({ builtInTools, schemaTools }, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			path.join("tools", "README.md"),
			[
				"# Tool Prompt Artifacts",
				"",
				`- Built-in tools with prompt text: ${builtInTools.length}`,
				`- Schema-only tools: ${schemaTools.length}`,
				"",
				"## Built-in",
				...builtInTools.map(
					(tool, index) =>
						`${index + 1}. [${tool.name}](./builtin/${tool.slug}.md)`,
				),
				"",
				"## Schema-only",
				...schemaTools.map(
					(tool, index) =>
						`${index + 1}. [${tool.name}](./schemas/${tool.slug}.md)`,
				),
			].join("\n"),
		);

		if (outputStyles) {
			writeArtifact(
				outputDir,
				written,
				"output-styles.json",
				`${JSON.stringify(outputStyles, null, 2)}\n`,
			);
		}

		writeArtifact(
			outputDir,
			written,
			"prompt-corpus.json",
			`${JSON.stringify(promptCorpusDebug, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			buildPromptDatasetFilename(resolved.label),
			`${JSON.stringify(promptDataset, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			"prompt-hash-index.json",
			`${JSON.stringify(promptHashIndex, null, 2)}\n`,
		);

		const aliasEntries = [...context.aliases.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([symbol, alias]) => ({ symbol, alias }));
		writeArtifact(
			outputDir,
			written,
			"runtime-symbol-map.json",
			`${JSON.stringify(aliasEntries, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			"README.md",
			[
				`# Prompt Export: ${resolved.label}`,
				"",
				`- [Built-in agents](./agents/README.md)`,
				`- [System prompts](./system/README.md)`,
				`- [Tool prompts](./tools/README.md)`,
				`- [Prompt corpus JSON](./prompt-corpus.json)`,
				`- [Prompt dataset JSON](./${buildPromptDatasetFilename(resolved.label)})`,
				`- [Prompt hash index JSON](./prompt-hash-index.json)`,
			].join("\n"),
		);

		const manifest = {
			label: resolved.label,
			sourceCliPath: resolved.cliPath,
			generatedAt: new Date().toISOString(),
			counts: {
				agents: agents.length,
				sections: sections.length,
				systemVariants: systemVariants.length,
				builtInTools: builtInTools.length,
				schemaTools: schemaTools.length,
				outputStyles: outputStyles?.styles.length ?? 0,
				promptCorpus: promptCorpusDebug.length,
				promptDataset: promptDataset.prompts.length,
				aliases: aliasEntries.length,
			},
			files: written.sort(),
		};
		writeArtifact(
			outputDir,
			written,
			"manifest.json",
			`${JSON.stringify(manifest, null, 2)}\n`,
		);

		console.log(`Exported prompt artifacts from ${resolved.cliPath}`);
		console.log(`Output directory: ${outputDir}`);
		console.log(
			`Counts: agents=${agents.length}, sections=${sections.length}, systemVariants=${systemVariants.length}, builtInTools=${builtInTools.length}, schemaTools=${schemaTools.length}, styles=${outputStyles?.styles.length ?? 0}, corpus=${promptCorpusDebug.length}, aliases=${aliasEntries.length}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to export prompts: ${message}`);
		process.exit(1);
	}
}

main();
