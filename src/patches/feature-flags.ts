import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const MONITOR_NAME = "Monitor";
const MONITOR_FLAG = "tengu_amber_sentinel";

interface MonitorGate {
	declaration: t.FunctionDeclaration;
}

function getMethodReturn(method: t.ObjectMethod): t.Expression | null {
	const returns = method.body.body.filter((statement) =>
		t.isReturnStatement(statement),
	);
	if (returns.length !== 1) return null;
	const argument = returns[0].argument;
	return argument && t.isExpression(argument) ? argument : null;
}

function findObjectMethod(
	object: t.ObjectExpression,
	name: string,
): t.ObjectMethod | null {
	const methods = object.properties.filter(
		(property): property is t.ObjectMethod =>
			t.isObjectMethod(property) && getObjectKeyName(property.key) === name,
	);
	return methods.length === 1 ? methods[0] : null;
}

function findMonitorGate(ast: t.File | t.Program): MonitorGate | string {
	const gates: t.FunctionDeclaration[] = [];
	const root = t.isFile(ast) ? ast : t.file(ast);

	traverse(root, {
		ObjectExpression(path) {
			const userFacingName = findObjectMethod(path.node, "userFacingName");
			if (!userFacingName) return;
			const nameReturn = getMethodReturn(userFacingName);
			if (!t.isStringLiteral(nameReturn, { value: MONITOR_NAME })) return;

			const isEnabled = findObjectMethod(path.node, "isEnabled");
			if (!isEnabled) return;
			const enabledReturn = getMethodReturn(isEnabled);
			if (!t.isLogicalExpression(enabledReturn, { operator: "&&" })) return;
			if (
				!t.isCallExpression(enabledReturn.left) ||
				!t.isIdentifier(enabledReturn.left.callee) ||
				enabledReturn.left.arguments.length !== 0
			) {
				return;
			}
			const binding = path.scope.getBinding(enabledReturn.left.callee.name);
			if (binding?.path.isFunctionDeclaration()) {
				gates.push(binding.path.node);
			}
		},
	});

	if (gates.length !== 1) {
		return `Expected one Monitor enablement site with a function binding, found ${gates.length}`;
	}
	return { declaration: gates[0] };
}

function getGateReturn(
	declaration: t.FunctionDeclaration,
): t.ReturnStatement | null {
	const returns = declaration.body.body.filter((statement) =>
		t.isReturnStatement(statement),
	);
	return returns.length === 1 ? returns[0] : null;
}

function isRemoteMonitorFlag(expression: t.Expression | null): boolean {
	return (
		t.isCallExpression(expression) &&
		expression.arguments.length === 2 &&
		t.isStringLiteral(expression.arguments[0], { value: MONITOR_FLAG }) &&
		(t.isBooleanLiteral(expression.arguments[1], { value: false }) ||
			(t.isUnaryExpression(expression.arguments[1], { operator: "!" }) &&
				t.isNumericLiteral(expression.arguments[1].argument, { value: 1 })))
	);
}

function createMonitorFlagMutator(): Visitor {
	return {
		Program: {
			exit(path) {
				const gate = findMonitorGate(path.node);
				if (typeof gate === "string") {
					throw new Error(`feature-flags: ${gate}`);
				}
				const gateReturn = getGateReturn(gate.declaration);
				if (!gateReturn?.argument) {
					throw new Error("feature-flags: Monitor gate return not found");
				}
				if (t.isBooleanLiteral(gateReturn.argument, { value: true })) return;
				if (!isRemoteMonitorFlag(gateReturn.argument)) {
					throw new Error(
						"feature-flags: Monitor gate no longer uses the expected remote flag",
					);
				}
				gateReturn.argument = t.booleanLiteral(true);
				console.log("Feature flags: enabled Monitor locally");
			},
		},
	};
}

export const featureFlags: Patch = {
	tag: "feature-flags",

	astPasses: () => [{ pass: "mutate", visitor: createMonitorFlagMutator() }],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST for feature-flags verification";
		const gate = findMonitorGate(verifyAst);
		if (typeof gate === "string") return gate;
		const gateReturn = getGateReturn(gate.declaration);
		if (
			!gateReturn ||
			!t.isBooleanLiteral(gateReturn.argument, { value: true })
		) {
			return "Monitor gate is not enabled locally";
		}
		return true;
	},
};
