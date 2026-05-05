import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

/**
 * Add an explicit env override for the past-context memory search prompt.
 */

function isProcessReference(node: t.Expression): boolean {
	if (t.isIdentifier(node)) return node.name === "process";
	if (!t.isMemberExpression(node)) return false;
	return (
		getMemberPropertyName(node) === "process" &&
		t.isIdentifier(node.object) &&
		node.object.name === "globalThis"
	);
}

function findTruthyCheckFn(ast: t.File): string | null {
	const scores = new Map<string, number>();
	const bump = (name: string, weight: number) => {
		scores.set(name, (scores.get(name) ?? 0) + weight);
	};

	traverse(ast, {
		CallExpression(path) {
			// Look for pattern: X(process.env.SOME_VAR)
			if (!t.isIdentifier(path.node.callee)) return;
			if (path.node.arguments.length !== 1) return;

			const arg = path.node.arguments[0];
			if (!t.isMemberExpression(arg)) return;
			if (!t.isMemberExpression(arg.object)) return;

			const innerObj = arg.object;
			if (!isProcessReference(innerObj.object)) return;
			if (getMemberPropertyName(innerObj) !== "env") return;

			const fnName = path.node.callee.name;
			// Any env helper call gets a baseline score.
			bump(fnName, 1);

			// Prefer helpers used directly as if-test predicates.
			const parent = path.parentPath;
			if (t.isIfStatement(parent?.node) && parent.node.test === path.node) {
				bump(fnName, 5);
				return;
			}

			// Also support negated and compound predicate forms:
			// if (!truthy(process.env.X)) ...
			if (
				t.isUnaryExpression(parent?.node, { operator: "!" }) &&
				parent.node.argument === path.node
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 4);
					return;
				}
			}

			// if (truthy(process.env.X) || ...)
			if (
				t.isLogicalExpression(parent?.node) &&
				(parent.node.operator === "||" || parent.node.operator === "&&")
			) {
				const grandParent = parent.parentPath;
				if (
					t.isIfStatement(grandParent?.node) &&
					grandParent.node.test === parent.node
				) {
					bump(fnName, 3);
				}
			}
		},
	});

	if (scores.size === 0) return null;

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	if (ranked.length === 1) return ranked[0][0];
	if (ranked[0][1] === ranked[1][1]) return null;
	return ranked[0][0];
}

function envMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function isNullOrEmptyArrayReturn(node: t.Statement): boolean {
	if (t.isReturnStatement(node)) {
		if (t.isNullLiteral(node.argument)) return true;
		if (
			t.isArrayExpression(node.argument) &&
			node.argument.elements.length === 0
		) {
			return true;
		}
	}
	if (t.isBlockStatement(node) && node.body.length === 1) {
		return isNullOrEmptyArrayReturn(node.body[0]);
	}
	return false;
}

function isFlagCall(node: t.Node, flagName: string): boolean {
	if (!t.isCallExpression(node)) return false;
	if (node.arguments.length < 1) return false;
	return t.isStringLiteral(node.arguments[0], { value: flagName });
}

function nodeContainsFlagCall(node: t.Node, flagName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (isFlagCall(maybeNode, flagName)) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function nodeContainsEnvRef(node: t.Node, envName: string): boolean {
	const visit = (value: unknown): boolean => {
		if (!value) return false;
		if (Array.isArray(value)) return value.some((item) => visit(item));
		if (typeof value !== "object") return false;
		const maybeNode = value as t.Node;
		if (typeof (maybeNode as { type?: unknown }).type !== "string")
			return false;
		if (t.isIdentifier(maybeNode, { name: envName })) return true;
		return Object.values(maybeNode as unknown as Record<string, unknown>).some(
			(child) => visit(child),
		);
	};
	return visit(node);
}

function createSessionMemoryMutator(truthyFn: string): Visitor {
	let patchedPastSessions = false;
	return {
		IfStatement(path) {
			const test = path.node.test;

			// Skip already-patched nodes
			if (
				t.isLogicalExpression(test) &&
				nodeContainsEnvRef(test, "ENABLE_SESSION_MEMORY_PAST")
			) {
				patchedPastSessions = true;
				return;
			}

			const envPastCheck = t.callExpression(t.identifier(truthyFn), [
				envMember("ENABLE_SESSION_MEMORY_PAST"),
			]);

			if (
				t.isUnaryExpression(test, { operator: "!" }) &&
				isFlagCall(test.argument, "tengu_coral_fern") &&
				isNullOrEmptyArrayReturn(path.node.consequent)
			) {
				path.node.test = t.logicalExpression(
					"&&",
					t.unaryExpression("!", envPastCheck),
					test,
				);
				patchedPastSessions = true;
				return;
			}
		},
		Program: {
			exit() {
				if (!patchedPastSessions) {
					console.warn(
						"Session memory: Could not find tengu_coral_fern past-session gate",
					);
				}
			},
		},
	};
}

export const sessionMemory: Patch = {
	tag: "session-mem",

	astPasses: (ast) => {
		const truthyFn = findTruthyCheckFn(ast);
		if (!truthyFn) {
			console.warn("Session memory: Could not find truthy check function");
			return [];
		}
		return [
			{
				pass: "mutate",
				visitor: createSessionMemoryMutator(truthyFn),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during session-memory verification";
		}

		let hasCoralFernCall = false;
		let hasOldCoralFernGuard = false;
		let hasPatchedPastSessionsGate = false;

		traverse(verifyAst, {
			CallExpression(path) {
				if (isFlagCall(path.node, "tengu_coral_fern")) {
					hasCoralFernCall = true;
				}
			},
			IfStatement(path) {
				const { test, consequent } = path.node;
				if (
					t.isUnaryExpression(test, { operator: "!" }) &&
					isFlagCall(test.argument, "tengu_coral_fern") &&
					isNullOrEmptyArrayReturn(consequent)
				) {
					hasOldCoralFernGuard = true;
				}
				if (
					nodeContainsFlagCall(test, "tengu_coral_fern") &&
					nodeContainsEnvRef(test, "ENABLE_SESSION_MEMORY_PAST")
				) {
					hasPatchedPastSessionsGate = true;
				}
			},
		});

		if (!hasCoralFernCall) {
			return "Missing tengu_coral_fern past-session gate";
		}
		if (hasOldCoralFernGuard) {
			return "Old tengu_coral_fern gate still present";
		}
		if (!hasPatchedPastSessionsGate) {
			return "Missing ENABLE_SESSION_MEMORY_PAST env var check";
		}
		return true;
	},
};
