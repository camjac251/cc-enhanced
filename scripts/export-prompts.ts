#!/usr/bin/env bun
/**
 * Export prompt artifacts from a clean/patched claude-code cli.js.
 *
 * Usage:
 *   bun scripts/export-prompts.ts [version-or-path]
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
import * as t from "@babel/types";
import { type NodePath, traverse } from "../src/babel.js";
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

interface SkillPrompt {
	name: string;
	slug: string;
	sourceSymbol: string | null;
	description: string | null;
	whenToUse: string | null;
	argumentHint: string | null;
	userInvocable: boolean;
	disableModelInvocation: boolean;
	allowedTools: string[];
	promptTexts: string[];
}

type CorpusCategory =
	| "tool-prompt"
	| "agent-prompt"
	| "skill-prompt"
	| "system-section"
	| "system-variant"
	| "system-reminder"
	| "internal-agent"
	| "data-reference"
	| "output-style"
	| "uncategorized";

interface CategorizedCorpusEntry {
	id: string;
	category: CorpusCategory;
	attribution: string | null;
	name: string;
	description: string;
	text: string;
	start: number;
	end: number;
}

interface SystemReminder {
	slug: string;
	sourceSymbol: string | null;
	template: string;
	isDynamic: boolean;
}

interface ToolSubSection {
	heading: string;
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

	traverse(ast, {
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
	traverse(ast, {
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

	if (t.isCallExpression(expression)) {
		// Direct function call: fn() or fn(arg, ...). Follow into the callee body
		// regardless of arity. Recursion is bounded by `seenFunctions`, and any
		// reference to an unresolved parameter inside the body falls back to null,
		// so callees that genuinely depend on their arguments still fail closed.
		if (expression.arguments.length === 0 && t.isIdentifier(expression.callee)) {
			const symbol = expression.callee.name;
			if (seenFunctions.has(symbol)) return null;
			const target = context.functionBindings.get(symbol);
			if (!target) return null;
			seenFunctions.add(symbol);
			return extractPromptFromFunctionNode(target, context, seenFunctions);
		}
		if (expression.arguments.length > 0 && t.isIdentifier(expression.callee)) {
			const symbol = expression.callee.name;
			if (seenFunctions.has(symbol)) return null;
			const target = context.functionBindings.get(symbol);
			if (target) {
				seenFunctions.add(symbol);
				return extractPromptFromFunctionNode(target, context, seenFunctions);
			}
		}
		// Method call on string-like: `template`.trim(), str.trim()
		if (
			expression.arguments.length === 0 &&
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
		if (!t.isExpression(expression.left)) return null;
		const leftExpr = expression.left;
		const rightExpr = expression.right;
		const left = renderPromptExpression(leftExpr, context, seenFunctions);
		const right = renderPromptExpression(rightExpr, context, seenFunctions);
		if (left !== null && right !== null) return left + right;
		if (left !== null)
			return `${left}\${${describeExpression(rightExpr, context)}}`;
		if (right !== null)
			return `\${${describeExpression(leftExpr, context)}}${right}`;
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
	const blockBody = node.body.body;
	const localExprs = collectLocalBindings(blockBody);
	return withLocalBindings(context, localExprs, seenFunctions, () => {
		for (const statement of blockBody) {
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

	traverse(ast, {
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

	traverse(ast, {
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
	traverse(ast, {
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
	traverse(ast, {
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
	traverse(ast, {
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

	traverse(ast, {
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
	traverse(ast, {
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
	type BuilderCandidate = {
		pathRef: NodePath<t.Function>;
		score: number;
	};
	const state: { best: BuilderCandidate | null } = { best: null };

	traverse(ast, {
		Function(pathRef) {
			const snippets = collectFunctionPromptSnippets(pathRef, context);
			const containsAnchor = snippets.some((snippet) =>
				snippet.includes(SYSTEM_PROMPT_ANCHOR),
			);
			if (!containsAnchor) return;
			const source =
				pathRef.node.start != null && pathRef.node.end != null
					? pathRef.node.end - pathRef.node.start
					: 0;
			const hasSimpleGuard = snippets.some((snippet) =>
				snippet.includes("CWD:"),
			);
			const score = source + (hasSimpleGuard ? 1_000_000 : 0);
			if (!state.best || score > state.best.score) {
				state.best = { pathRef, score };
			}
		},
	});

	const best = state.best;
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

function isValidSkillName(name: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) && name.length <= 80;
}

function extractBooleanValue(
	objectNode: t.ObjectExpression,
	propertyName: string,
): boolean | null {
	const prop = getObjectProperty(objectNode, propertyName);
	if (!prop || !t.isObjectProperty(prop)) return null;
	if (t.isBooleanLiteral(prop.value)) return prop.value.value;
	if (
		t.isUnaryExpression(prop.value) &&
		prop.value.operator === "!" &&
		t.isNumericLiteral(prop.value.argument)
	) {
		return prop.value.argument.value === 0;
	}
	return null;
}

function extractStringArrayFromObject(
	objectNode: t.ObjectExpression,
	propertyName: string,
	context: RenderContext,
): string[] {
	const prop = getObjectProperty(objectNode, propertyName);
	if (!prop || !t.isObjectProperty(prop)) return [];
	if (!t.isExpression(prop.value)) return [];
	if (t.isArrayExpression(prop.value)) {
		const result: string[] = [];
		for (const elem of prop.value.elements) {
			if (!elem || t.isSpreadElement(elem)) continue;
			if (t.isStringLiteral(elem)) {
				result.push(elem.value);
			} else if (t.isExpression(elem)) {
				const rendered = renderStringLikeNode(elem, context);
				if (rendered) result.push(rendered);
			}
		}
		return result;
	}
	if (t.isIdentifier(prop.value)) {
		return [`\${${resolveIdentifierName(prop.value.name, context)}}`];
	}
	return [];
}

function extractTextFromSkillReturn(
	expression: t.Expression,
	context: RenderContext,
): string | null {
	if (!t.isArrayExpression(expression)) return null;
	const parts: string[] = [];
	for (const element of expression.elements) {
		if (
			!element ||
			t.isSpreadElement(element) ||
			!t.isObjectExpression(element)
		) {
			continue;
		}
		const typeProp = getObjectProperty(element, "type");
		if (!typeProp || !t.isObjectProperty(typeProp)) continue;
		if (!t.isStringLiteral(typeProp.value) || typeProp.value.value !== "text") {
			continue;
		}
		const textProp = getObjectProperty(element, "text");
		if (!textProp || !t.isObjectProperty(textProp)) continue;
		if (!t.isExpression(textProp.value)) continue;
		const resolved = renderPromptExpression(textProp.value, context);
		if (resolved) parts.push(resolved);
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

function collectReturnedSkillTexts(
	body: t.BlockStatement,
	context: RenderContext,
): string[] {
	const texts: string[] = [];
	const seen = new Set<string>();

	function walkStatements(stmts: t.Statement[]): void {
		for (const stmt of stmts) {
			if (
				t.isReturnStatement(stmt) &&
				stmt.argument &&
				t.isExpression(stmt.argument)
			) {
				const text = extractTextFromSkillReturn(stmt.argument, context);
				if (text && text.length >= 50 && !seen.has(text)) {
					seen.add(text);
					texts.push(text);
				}
			} else if (t.isIfStatement(stmt)) {
				walkBlock(stmt.consequent);
				if (stmt.alternate) walkBlock(stmt.alternate);
			} else if (t.isBlockStatement(stmt)) {
				walkStatements(stmt.body);
			} else if (t.isTryStatement(stmt)) {
				walkStatements(stmt.block.body);
			} else if (t.isSwitchStatement(stmt)) {
				for (const c of stmt.cases) walkStatements(c.consequent);
			}
		}
	}

	function walkBlock(node: t.Statement): void {
		if (t.isBlockStatement(node)) walkStatements(node.body);
		else walkStatements([node]);
	}

	walkStatements(body.body);
	return texts;
}

function extractSkillPromptTexts(
	functionNode: FunctionLikeNode,
	context: RenderContext,
): string[] {
	if (!t.isBlockStatement(functionNode.body)) return [];
	const localExprs = collectLocalBindings(functionNode.body.body);
	const saved = new Map<string, string | undefined>();
	for (const [name, expr] of localExprs) {
		saved.set(name, context.stringBindings.get(name));
		const resolved = renderPromptExpression(expr, context);
		if (resolved !== null) context.stringBindings.set(name, resolved);
	}
	try {
		return collectReturnedSkillTexts(functionNode.body, context);
	} finally {
		for (const [name, original] of saved) {
			if (original === undefined) context.stringBindings.delete(name);
			else context.stringBindings.set(name, original);
		}
	}
}

function collectSkillPrompts(
	ast: t.File,
	context: RenderContext,
): SkillPrompt[] {
	const byName = new Map<string, SkillPrompt>();
	const usedSlugs = new Set<string>();

	traverse(ast, {
		ObjectExpression(pathRef) {
			const nameProp = getObjectProperty(pathRef.node, "name");
			const getPromptProp =
				getObjectProperty(pathRef.node, "getPromptForCommand") ??
				getObjectProperty(pathRef.node, "getPromptWhileMarketplaceIsPrivate");
			if (!nameProp || !getPromptProp) return;

			const name = extractPropertyText(nameProp, context)?.trim();
			if (!name || !isValidSkillName(name)) return;

			// Skip explicitly disabled skills: isEnabled: () => !1
			const isEnabledProp = getObjectProperty(pathRef.node, "isEnabled");
			if (isEnabledProp && t.isObjectProperty(isEnabledProp)) {
				const val = isEnabledProp.value;
				if (
					t.isArrowFunctionExpression(val) &&
					!t.isBlockStatement(val.body) &&
					t.isUnaryExpression(val.body) &&
					val.body.operator === "!" &&
					t.isNumericLiteral(val.body.argument) &&
					val.body.argument.value === 1
				) {
					return;
				}
			}

			const descProp = getObjectProperty(pathRef.node, "description");
			const description = descProp
				? (extractPropertyText(descProp, context)?.trim() ?? null)
				: null;

			const whenToUseProp = getObjectProperty(pathRef.node, "whenToUse");
			const whenToUse = whenToUseProp
				? (extractPropertyText(whenToUseProp, context)?.trim() ?? null)
				: null;

			const argHintProp = getObjectProperty(pathRef.node, "argumentHint");
			const argumentHint = argHintProp
				? (extractPropertyText(argHintProp, context)?.trim() ?? null)
				: null;

			const userInvocable =
				extractBooleanValue(pathRef.node, "userInvocable") ?? false;
			const disableModelInvocation =
				extractBooleanValue(pathRef.node, "disableModelInvocation") ?? false;
			const allowedTools = extractStringArrayFromObject(
				pathRef.node,
				"allowedTools",
				context,
			);

			const promptFunction = getFunctionFromPromptProperty(
				getPromptProp,
				context,
			);
			let promptTexts: string[] = [];
			if (promptFunction) {
				promptTexts = extractSkillPromptTexts(promptFunction, context);
			}
			// Fallback: try getPromptWhileMarketplaceIsPrivate
			if (promptTexts.length === 0) {
				const marketplaceProp = getObjectProperty(
					pathRef.node,
					"getPromptWhileMarketplaceIsPrivate",
				);
				if (marketplaceProp) {
					const mpFunc = getFunctionFromPromptProperty(
						marketplaceProp,
						context,
					);
					if (mpFunc) {
						promptTexts = extractSkillPromptTexts(mpFunc, context);
					}
				}
			}

			const sourceSymbol = inferAssignedSymbol(pathRef);
			const existing = byName.get(name);
			const candidate: SkillPrompt = {
				name,
				slug: existing?.slug ?? createUniqueSlug(slugify(name), usedSlugs),
				sourceSymbol,
				description,
				whenToUse,
				argumentHint,
				userInvocable,
				disableModelInvocation,
				allowedTools,
				promptTexts,
			};

			if (
				!existing ||
				candidate.promptTexts.length > existing.promptTexts.length ||
				(candidate.promptTexts.length === existing.promptTexts.length &&
					(candidate.description?.length ?? 0) >
						(existing.description?.length ?? 0))
			) {
				byName.set(name, candidate);
			}
		},
	});

	return [...byName.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

function collectSystemReminders(
	ast: t.File,
	context: RenderContext,
): SystemReminder[] {
	const reminders: SystemReminder[] = [];
	const seen = new Set<string>();
	const usedSlugs = new Set<string>();

	traverse(ast, {
		TemplateLiteral(pathRef) {
			const text = renderTemplateLiteral(pathRef.node, context);
			if (!text.includes("<system-reminder>")) return;
			// Extract content between tags
			const match = text.match(
				/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/,
			);
			if (!match) return;
			const content = match[1].trim();
			if (content.length < 20 || seen.has(content)) return;
			seen.add(content);
			const firstLine = content.split("\n")[0].trim().slice(0, 60);
			const slug = createUniqueSlug(
				slugify(firstLine) || "reminder",
				usedSlugs,
			);
			const isDynamic = content.includes("${");
			const parentPath = pathRef.parentPath;
			let sourceSymbol: string | null = null;
			if (
				parentPath?.isVariableDeclarator() &&
				t.isIdentifier(parentPath.node.id)
			) {
				sourceSymbol = parentPath.node.id.name;
			} else if (
				parentPath?.isAssignmentExpression() &&
				t.isIdentifier(parentPath.node.left)
			) {
				sourceSymbol = parentPath.node.left.name;
			}
			reminders.push({ slug, sourceSymbol, template: content, isDynamic });
		},
		StringLiteral(pathRef) {
			const text = pathRef.node.value;
			if (!text.includes("<system-reminder>")) return;
			const match = text.match(
				/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/,
			);
			if (!match) return;
			const content = match[1].trim();
			if (content.length < 20 || seen.has(content)) return;
			seen.add(content);
			const firstLine = content.split("\n")[0].trim().slice(0, 60);
			const slug = createUniqueSlug(
				slugify(firstLine) || "reminder",
				usedSlugs,
			);
			reminders.push({
				slug,
				sourceSymbol: null,
				template: content,
				isDynamic: content.includes("${"),
			});
		},
	});

	// Also find system-reminder wrapper calls with static content
	traverse(ast, {
		CallExpression(pathRef) {
			if (!t.isIdentifier(pathRef.node.callee)) return;
			// Look for calls to the system-reminder wrapper (single-arg, returns <system-reminder>)
			if (pathRef.node.arguments.length !== 1) return;
			const arg = pathRef.node.arguments[0];
			if (!t.isExpression(arg)) return;
			const resolved = renderPromptExpression(arg, context);
			if (!resolved || resolved.length < 20 || seen.has(resolved)) return;
			// Verify this is the wrapper by checking if caller resolves to system-reminder pattern
			const calleeName = pathRef.node.callee.name;
			const calleeFn = context.functionBindings.get(calleeName);
			if (!calleeFn || !t.isBlockStatement(calleeFn.body)) return;
			// Check if function body contains "<system-reminder>"
			let isReminderWrapper = false;
			for (const stmt of calleeFn.body.body) {
				if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
				const returnText = renderPromptExpression(
					stmt.argument as t.Expression,
					context,
				);
				if (returnText?.includes("<system-reminder>")) {
					isReminderWrapper = true;
					break;
				}
			}
			if (!isReminderWrapper) return;
			seen.add(resolved);
			const firstLine = resolved.split("\n")[0].trim().slice(0, 60);
			const slug = createUniqueSlug(
				slugify(firstLine) || "reminder",
				usedSlugs,
			);
			reminders.push({
				slug,
				sourceSymbol: null,
				template: resolved,
				isDynamic: resolved.includes("${"),
			});
		},
	});

	return reminders.sort((a, b) => a.slug.localeCompare(b.slug));
}

function decomposeToolSubSections(prompt: string): ToolSubSection[] {
	const lines = prompt.split("\n");
	const sections: ToolSubSection[] = [];
	const usedSlugs = new Set<string>();
	let currentHeading: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
		if (headingMatch) {
			if (currentHeading && currentLines.length > 0) {
				const text = currentLines.join("\n").trim();
				if (text.length > 0) {
					sections.push({
						heading: currentHeading,
						slug: createUniqueSlug(slugify(currentHeading), usedSlugs),
						text,
					});
				}
			}
			currentHeading = headingMatch[2].trim();
			currentLines = [];
		} else {
			currentLines.push(line);
		}
	}
	if (currentHeading && currentLines.length > 0) {
		const text = currentLines.join("\n").trim();
		if (text.length > 0) {
			sections.push({
				heading: currentHeading,
				slug: createUniqueSlug(slugify(currentHeading), usedSlugs),
				text,
			});
		}
	}
	return sections;
}

function categorizeByContent(text: string): CorpusCategory {
	const lower = text.toLowerCase();

	// System reminders
	if (text.includes("<system-reminder>") || text.includes("</system-reminder>"))
		return "system-reminder";

	// Data references (API docs, SDK examples)
	if (
		(text.includes("```python") || text.includes("```typescript")) &&
		(lower.includes("import anthropic") ||
			lower.includes("from anthropic") ||
			lower.includes("@anthropic-ai/sdk"))
	)
		return "data-reference";
	if (
		text.length > 3000 &&
		(text.match(/```/g)?.length ?? 0) >= 4 &&
		(lower.includes("api") || lower.includes("sdk"))
	)
		return "data-reference";

	// Internal agent prompts (not registered agents, but instructional)
	// Declarative framing: "You are a/an..."
	if (
		(text.startsWith("You are a") ||
			text.startsWith("You are an") ||
			text.startsWith("Your task is") ||
			text.startsWith("Your job is")) &&
		!text.includes("You are Claude Code") &&
		!text.includes("You are the Claude guide") &&
		!text.includes("You are an interactive agent")
	)
		return "internal-agent";
	// Imperative framing: "Generate/Write/Describe/Analyze..."
	if (
		/^(Generate|Write|Describe|Analyze|Create|Extract|Summarize|Evaluate|Convert|Parse|Determine)\s/i.test(
			text,
		) &&
		text.length < 5000
	)
		return "internal-agent";
	// Task-oriented with "your task" or "output" pattern
	if (
		lower.includes("your task") &&
		lower.includes("output") &&
		text.length < 2000
	)
		return "internal-agent";
	// Policy/classifier documents
	if (
		text.includes("<policy_spec>") ||
		(lower.includes("risk level") && lower.includes("block"))
	)
		return "internal-agent";
	// Fork/worker agent base prompts
	if (
		text.startsWith("You are a forked worker") ||
		text.startsWith("You are an agent for Claude Code")
	)
		return "internal-agent";

	// System reminders injected via wrapper without literal tags
	if (
		text.startsWith("Note:") ||
		text.startsWith("Warning:") ||
		text.startsWith("Async agent launched") ||
		text.startsWith("A message arrived from") ||
		text.startsWith("Do not duplicate this agent") ||
		text.startsWith("Plan mode is active") ||
		text.startsWith("You have been working on the task") ||
		text.startsWith("Ultraplan complete") ||
		text.startsWith("Permission to use") ||
		text.startsWith("IMPORTANT: This message and these instructions are NOT")
	)
		return "system-reminder";
	// Plan mode / re-entry / compact reminders
	if (
		lower.includes("plan mode") &&
		(lower.includes("re-entering") ||
			lower.includes("is active") ||
			lower.includes("interview"))
	)
		return "system-reminder";

	// Tool descriptions and parameters
	if (
		text.startsWith("Wait for a specified") ||
		text.startsWith("Use a mouse and keyboard") ||
		text.startsWith("Lists available resources") ||
		text.startsWith("Fetches content from") ||
		text.startsWith("Clear, concise description") ||
		text.startsWith("IMPORTANT: Avoid using this tool")
	)
		return "tool-prompt";
	// Tool descriptions by content patterns
	if (
		/^(Execute|Search|Launch|Read|Write|Edit|Create|Send|Set|Stop|Exit)\s/i.test(
			text,
		) &&
		lower.includes("tool") &&
		text.length < 3000
	)
		return "tool-prompt";

	// System sections (headings or IMPORTANT blocks)
	if (/^#\s/.test(text) && text.length > 200) return "system-section";
	if (/^#{2,3}\s/.test(text) && text.length > 100) return "system-section";
	if (
		text.startsWith("IMPORTANT:") &&
		text.length > 200 &&
		!text.includes("NOT part of")
	)
		return "system-section";

	// System variant
	if (text.startsWith("You are Claude Code")) return "system-variant";
	if (text.startsWith("You are the Claude guide")) return "system-variant";
	if (text.startsWith("You are an interactive agent")) return "system-variant";

	// Agent sub-prompts (explore/plan strengths, fork instructions, etc.)
	if (
		lower.includes("general-purpose agent") ||
		lower.includes("agent for claude code") ||
		lower.includes("forked worker") ||
		lower.includes("agent threads always")
	)
		return "agent-prompt";

	// Tool descriptions with leading whitespace
	const trimmed = text.trimStart();
	if (
		(trimmed.startsWith("Reads a file") ||
			trimmed.startsWith("Lists available resources") ||
			trimmed.startsWith("Fetches content from") ||
			trimmed.startsWith("- Fetches content") ||
			trimmed.startsWith("Browser extension is not")) &&
		text.length < 3000
	)
		return "tool-prompt";
	// Tool prompt sub-parts (constraints, notes, usage)
	if (
		trimmed.startsWith("**Tool constraints") ||
		trimmed.startsWith("**Browser Automation") ||
		trimmed.startsWith("**IMPORTANT: Before using") ||
		trimmed.startsWith("You can use the `run_in_background`") ||
		trimmed.startsWith("Usage notes:")
	)
		return "tool-prompt";
	// Tool descriptions starting with "# ToolName" after trim
	if (/^#\s+[A-Z][a-zA-Z]+\b/.test(trimmed) && lower.includes("when to use"))
		return "tool-prompt";

	// Memory prompt sub-parts (XML-tagged descriptions)
	if (
		trimmed.startsWith("<description>") ||
		trimmed.startsWith("<how_to_use>") ||
		trimmed.startsWith("<when_to_save>") ||
		lower.includes("memory extraction subagent")
	)
		return "internal-agent";

	// System sections with leading whitespace
	if (/^#{1,3}\s/.test(trimmed) && trimmed.length > 200)
		return "system-section";
	// Numbered/bold sub-sections of system prompt
	if (
		/^\d+\.\s+\*\*/.test(trimmed) &&
		trimmed.length > 200 &&
		lower.includes("agent")
	)
		return "system-section";

	// Config/schema descriptions
	if (
		lower.includes("glob patterns") ||
		lower.includes("regex pattern") ||
		lower.includes("allowlist of") ||
		lower.includes("user-configurable values")
	)
		return "data-reference";

	// Error/status messages with instructional content
	if (
		text.startsWith("Error:") ||
		trimmed.startsWith("Error:") ||
		text.startsWith("SSH host key") ||
		text.startsWith("Environment is configured") ||
		text.startsWith("It looks like you're running") ||
		text.startsWith("Enable weaker network") ||
		text.startsWith("Browser extension is not")
	)
		return "system-reminder";

	// Bridge/transport messages (not really prompts, but captured by corpus)
	if (text.startsWith("[bridge:repl]")) return "uncategorized";

	// Internal agents missed by imperative check (starts with newline or interpolation)
	if (
		trimmed.startsWith("You are coming up with") ||
		trimmed.startsWith("You are now acting as") ||
		trimmed.startsWith("Provide a concise response")
	)
		return "internal-agent";

	// Session/plan state messages
	if (
		lower.includes("the user has indicated") ||
		lower.includes("stop asking clarify")
	)
		return "system-reminder";

	return "uncategorized";
}

function categorizeCorpus(
	debugCorpus: Array<{
		id: string;
		name: string;
		description: string;
		text: string;
	}>,
	corpus: PromptCorpusEntry[],
	tools: ToolPrompt[],
	agents: AgentPrompt[],
	skills: SkillPrompt[],
	sections: SectionPrompt[],
	reminders: SystemReminder[],
): CategorizedCorpusEntry[] {
	// Build text index for attribution
	const attributionIndex: Array<{
		textSnippet: string;
		category: CorpusCategory;
		attribution: string;
	}> = [];

	for (const tool of tools) {
		if (tool.prompt) {
			attributionIndex.push({
				textSnippet: tool.prompt.slice(0, 200),
				category: "tool-prompt",
				attribution: `tool:${tool.name}`,
			});
		}
		if (tool.description) {
			attributionIndex.push({
				textSnippet: tool.description.slice(0, 200),
				category: "tool-prompt",
				attribution: `tool:${tool.name}`,
			});
		}
	}
	for (const agent of agents) {
		attributionIndex.push({
			textSnippet: agent.prompt.slice(0, 200),
			category: "agent-prompt",
			attribution: `agent:${agent.agentType}`,
		});
	}
	for (const skill of skills) {
		if (skill.description) {
			attributionIndex.push({
				textSnippet: skill.description.slice(0, 200),
				category: "skill-prompt",
				attribution: `skill:${skill.name}`,
			});
		}
		for (const pt of skill.promptTexts) {
			attributionIndex.push({
				textSnippet: pt.slice(0, 200),
				category: "skill-prompt",
				attribution: `skill:${skill.name}`,
			});
		}
	}
	for (const section of sections) {
		for (const snippet of section.snippets) {
			attributionIndex.push({
				textSnippet: snippet.slice(0, 200),
				category: "system-section",
				attribution: `section:${section.slug}`,
			});
		}
	}
	for (const reminder of reminders) {
		attributionIndex.push({
			textSnippet: reminder.template.slice(0, 200),
			category: "system-reminder",
			attribution: `reminder:${reminder.slug}`,
		});
	}

	// Build corpus entry map
	const corpusByIndex = new Map<number, PromptCorpusEntry>();
	for (let i = 0; i < corpus.length; i++) {
		corpusByIndex.set(i, corpus[i]);
	}

	return debugCorpus.map((entry, index) => {
		const raw = corpusByIndex.get(index);
		// Try attribution matching (first 200 chars prefix match)
		const textPrefix = entry.text.slice(0, 200);
		let bestMatch: {
			category: CorpusCategory;
			attribution: string;
		} | null = null;
		for (const candidate of attributionIndex) {
			if (
				textPrefix.startsWith(candidate.textSnippet.slice(0, 100)) ||
				candidate.textSnippet.startsWith(textPrefix.slice(0, 100))
			) {
				bestMatch = {
					category: candidate.category,
					attribution: candidate.attribution,
				};
				break;
			}
		}

		const category = bestMatch?.category ?? categorizeByContent(entry.text);
		const attribution = bestMatch?.attribution ?? null;

		return {
			id: entry.id,
			category,
			attribution,
			name: entry.name,
			description: entry.description,
			text: entry.text,
			start: raw?.start ?? 0,
			end: raw?.end ?? 0,
		};
	});
}

function labelSkillVariant(
	text: string,
	_skillName: string,
): "prompt" | "usage" | "error" {
	const lower = text.toLowerCase();
	if (
		lower.includes("provide an instruction") ||
		lower.includes("usage:") ||
		lower.includes("examples:\n")
	)
		return "usage";
	if (
		lower.includes("not a git repo") ||
		lower.includes("error") ||
		lower.includes("requires a git repo")
	)
		return "error";
	return "prompt";
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
		const skills = collectSkillPrompts(ast, context);
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
		const systemReminders = collectSystemReminders(ast, context);
		const categorizedCorpus = categorizeCorpus(
			promptCorpusDebug,
			promptCorpus,
			builtInTools,
			agents,
			skills,
			sections,
			systemReminders,
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

		for (const skill of skills) {
			const metaLines = [
				`# Skill: ${skill.name}`,
				"",
				`- user_invocable: ${skill.userInvocable}`,
				`- disable_model_invocation: ${skill.disableModelInvocation}`,
				`- allowed_tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "none"}`,
			];
			if (skill.whenToUse) metaLines.push(`- when_to_use: ${skill.whenToUse}`);
			if (skill.argumentHint)
				metaLines.push(`- argument_hint: ${skill.argumentHint}`);
			metaLines.push(`- source_symbol: ${skill.sourceSymbol ?? "unknown"}`);

			const skillSections = [...metaLines];
			if (skill.description) {
				skillSections.push("", "## Description", "", skill.description);
			}
			if (skill.promptTexts.length === 1) {
				skillSections.push("", "## Prompt", "", skill.promptTexts[0]);
			} else if (skill.promptTexts.length > 1) {
				for (let i = 0; i < skill.promptTexts.length; i++) {
					const variantLabel = labelSkillVariant(
						skill.promptTexts[i],
						skill.name,
					);
					skillSections.push(
						"",
						`## Prompt (${variantLabel})`,
						"",
						skill.promptTexts[i],
					);
				}
			} else {
				skillSections.push(
					"",
					"## Prompt",
					"",
					"(Dynamic prompt: not statically resolved from cli.js AST.)",
				);
			}
			writeArtifact(
				outputDir,
				written,
				path.join("skills", `${skill.slug}.md`),
				skillSections.join("\n"),
			);
		}
		writeArtifact(
			outputDir,
			written,
			"skills.json",
			`${JSON.stringify(skills, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			path.join("skills", "README.md"),
			[
				"# Built-in Skills (Prompt)",
				"",
				`- Total: ${skills.length}`,
				"",
				...skills.map(
					(skill, index) =>
						`${index + 1}. [${skill.name}](./${skill.slug}.md)${skill.userInvocable ? "" : " (model-only)"}`,
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

		// System reminders
		for (const reminder of systemReminders) {
			writeArtifact(
				outputDir,
				written,
				path.join("system", "reminders", `${reminder.slug}.md`),
				[
					`# System Reminder: ${reminder.slug}`,
					"",
					`- source_symbol: ${reminder.sourceSymbol ?? "unknown"}`,
					`- is_dynamic: ${reminder.isDynamic}`,
					"",
					reminder.template,
				].join("\n"),
			);
		}
		writeArtifact(
			outputDir,
			written,
			path.join("system", "reminders.json"),
			`${JSON.stringify(systemReminders, null, 2)}\n`,
		);

		// Categorized corpus
		const categorySummary = new Map<CorpusCategory, number>();
		for (const entry of categorizedCorpus) {
			categorySummary.set(
				entry.category,
				(categorySummary.get(entry.category) ?? 0) + 1,
			);
		}
		writeArtifact(
			outputDir,
			written,
			"corpus-categorized.json",
			`${JSON.stringify(categorizedCorpus, null, 2)}\n`,
		);
		writeArtifact(
			outputDir,
			written,
			"corpus-summary.json",
			`${JSON.stringify(
				{
					total: categorizedCorpus.length,
					byCategory: Object.fromEntries(
						[...categorySummary.entries()].sort(([, a], [, b]) => b - a),
					),
				},
				null,
				2,
			)}\n`,
		);

		// Tool sub-sections (granular decomposition)
		const toolSubSections: Record<string, ToolSubSection[]> = {};
		for (const tool of builtInTools) {
			if (!tool.prompt || tool.prompt.length < 500) continue;
			const subs = decomposeToolSubSections(tool.prompt);
			if (subs.length >= 2) {
				toolSubSections[tool.name] = subs;
				for (const sub of subs) {
					writeArtifact(
						outputDir,
						written,
						path.join("tools", "sections", tool.slug, `${sub.slug}.md`),
						[`# ${tool.name}: ${sub.heading}`, "", sub.text].join("\n"),
					);
				}
			}
		}
		if (Object.keys(toolSubSections).length > 0) {
			writeArtifact(
				outputDir,
				written,
				path.join("tools", "sections.json"),
				`${JSON.stringify(toolSubSections, null, 2)}\n`,
			);
		}

		// Data references (from categorized corpus)
		const dataRefs = categorizedCorpus.filter(
			(e) => e.category === "data-reference",
		);
		if (dataRefs.length > 0) {
			writeArtifact(
				outputDir,
				written,
				"data-references.json",
				`${JSON.stringify(
					dataRefs.map((d) => ({
						id: d.id,
						name: d.name,
						attribution: d.attribution,
						textLength: d.text.length,
						preview: d.text.slice(0, 200),
					})),
					null,
					2,
				)}\n`,
			);
		}

		// Internal agent prompts (from categorized corpus)
		const internalAgents = categorizedCorpus.filter(
			(e) => e.category === "internal-agent",
		);
		if (internalAgents.length > 0) {
			for (const ia of internalAgents) {
				const iaSlug = slugify(ia.name.slice(0, 80)) || ia.id;
				writeArtifact(
					outputDir,
					written,
					path.join("internal-agents", `${iaSlug}.md`),
					[
						`# Internal Agent: ${ia.name}`,
						"",
						`- id: ${ia.id}`,
						`- attribution: ${ia.attribution ?? "unknown"}`,
						"",
						ia.text,
					].join("\n"),
				);
			}
			writeArtifact(
				outputDir,
				written,
				path.join("internal-agents", "README.md"),
				[
					"# Internal Agent Prompts",
					"",
					`- Total: ${internalAgents.length}`,
					"",
					...internalAgents.map(
						(ia, i) => `${i + 1}. ${ia.name} (${ia.text.length} chars)`,
					),
				].join("\n"),
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
				`- [Skills](./skills/README.md)`,
				`- [System prompts](./system/README.md)`,
				`- [Tool prompts](./tools/README.md)`,
				internalAgents.length > 0
					? `- [Internal agents](./internal-agents/README.md)`
					: null,
				`- [Corpus (categorized)](./corpus-categorized.json)`,
				`- [Corpus summary](./corpus-summary.json)`,
				dataRefs.length > 0
					? `- [Data references](./data-references.json)`
					: null,
				`- [Prompt corpus JSON](./prompt-corpus.json)`,
				`- [Prompt dataset JSON](./${buildPromptDatasetFilename(resolved.label)})`,
				`- [Prompt hash index JSON](./prompt-hash-index.json)`,
			]
				.filter(Boolean)
				.join("\n"),
		);

		const manifest = {
			label: resolved.label,
			sourceCliPath: resolved.cliPath,
			generatedAt: new Date().toISOString(),
			counts: {
				agents: agents.length,
				skills: skills.length,
				sections: sections.length,
				systemVariants: systemVariants.length,
				systemReminders: systemReminders.length,
				builtInTools: builtInTools.length,
				schemaTools: schemaTools.length,
				outputStyles: outputStyles?.styles.length ?? 0,
				internalAgents: internalAgents.length,
				dataReferences: dataRefs.length,
				promptCorpus: promptCorpusDebug.length,
				categorizedCorpus: Object.fromEntries(categorySummary),
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
			`Counts: agents=${agents.length}, skills=${skills.length}, sections=${sections.length}, variants=${systemVariants.length}, reminders=${systemReminders.length}, tools=${builtInTools.length}, schemas=${schemaTools.length}, styles=${outputStyles?.styles.length ?? 0}, internalAgents=${internalAgents.length}, dataRefs=${dataRefs.length}, corpus=${promptCorpusDebug.length}, aliases=${aliasEntries.length}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to export prompts: ${message}`);
		process.exit(1);
	}
}

main();
