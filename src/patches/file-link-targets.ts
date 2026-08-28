import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
} from "./ast-helpers.js";

const HELPER_NAME = "_ccEnhancedOpenFileTarget";
const DBUS_COMMAND = "dbus-send";
const FILE_MANAGER_METHOD = "org.freedesktop.FileManager1.ShowItems";

const HELPER_SOURCE = `
async function ${HELPER_NAME}(filePath, stockOpen, runProcess, logWarning) {
  var env = typeof process !== "undefined" && process.env ? process.env : {};
  var configuredMode = env.CLAUDE_CODE_FILE_OPEN_MODE;
  var mode = String(configuredMode || "auto").trim().toLowerCase();
  if (mode === "stock" || mode === "off") return await stockOpen(filePath);

  var isWsl =
    typeof process !== "undefined" &&
    process.platform === "linux" &&
    Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.WSLENV);
  var customOpener =
    typeof env.CLAUDE_CODE_FILE_OPENER === "string"
      ? env.CLAUDE_CODE_FILE_OPENER.trim()
      : "";
  var command = "";
  var openerKind = "";
  var args = [filePath];

  if (mode === "vscode") {
    command = "code";
    openerKind = "vscode";
    args = ["--reuse-window", filePath];
  } else if (mode === "wslview") {
    command = "wslview";
    openerKind = "wslview";
  } else if (mode === "auto" && customOpener) {
    command = customOpener;
    openerKind = "custom";
  } else if (mode === "auto" && isWsl) {
    command = "wslview";
    openerKind = "wslview";
  } else {
    return await stockOpen(filePath);
  }

  try {
    var result = await runProcess(command, args);
    if (result && result.code === 0) return true;
    var exitCode =
      result && typeof result.code === "number" ? result.code : "unknown";
    logWarning(
      "[file-open] " +
        openerKind +
        " opener failed (exit " +
        exitCode +
        ")",
      { level: "warn" },
    );
    return false;
  } catch {
    logWarning(
      "[file-open] " + openerKind + " opener failed (exception)",
      { level: "warn" },
    );
    return false;
  }
}
`;

interface StockRevealBindings {
	revealName: string;
	revealBindingNode: t.Node;
	runnerName: string;
	runnerBindingNode: t.Node | null;
}

interface StockDispatchCall {
	awaitNode: t.AwaitExpression;
	callNode: t.CallExpression;
	filePathExpression: t.Identifier;
	stockBindingNode: t.Node | null;
	stockOpenName: string;
}

interface HelperDispatchCall {
	awaitNode: t.AwaitExpression;
	callNode: t.CallExpression;
	filePathExpression: t.Identifier | null;
	loggerBindingNode: t.Node | null;
	loggerName: string | null;
	runnerBindingNode: t.Node | null;
	stockOpenName: string | null;
	stockBindingNode: t.Node | null;
	runnerName: string | null;
}

interface DispatcherAnalysis {
	containerBody: t.Statement[];
	functionNode: t.FunctionDeclaration;
	helperCalls: HelperDispatchCall[];
	loggerBindingNode: t.Node;
	loggerName: string;
	stockCalls: StockDispatchCall[];
}

interface AllowlistLoggerCall {
	callNode: t.CallExpression;
	loggerName: string;
}

interface FileLinkPassState {
	bindingCandidates: StockRevealBindings[];
	bindings?: StockRevealBindings;
	dispatcherCandidates: DispatcherAnalysis[];
	dispatcherCount: number;
	helperCount: number;
	patchedCount: number;
}

function isStringLiteral(node: t.Node | null | undefined, value: string) {
	return t.isStringLiteral(node, { value });
}

function getCallableName(path: NodePath<t.Function>): string | null {
	const node = path.node;
	if (t.isFunctionDeclaration(node) && node.id?.name) return node.id.name;
	if (t.isFunctionExpression(node) && node.id?.name) return node.id.name;

	const parent = path.parentPath;
	if (
		parent?.isVariableDeclarator() &&
		t.isIdentifier(parent.node.id) &&
		parent.node.init === node
	) {
		return parent.node.id.name;
	}
	if (
		parent?.isAssignmentExpression() &&
		t.isIdentifier(parent.node.left) &&
		parent.node.right === node
	) {
		return parent.node.left.name;
	}
	return null;
}

function getObjectPatternBindingName(
	pattern: t.ObjectPattern,
	keyName: string,
): string | null {
	const names = pattern.properties.flatMap((property) => {
		if (
			!t.isObjectProperty(property) ||
			getObjectKeyName(property.key) !== keyName ||
			!t.isIdentifier(property.value)
		) {
			return [];
		}
		return [property.value.name];
	});
	return names.length === 1 ? names[0] : null;
}

function getZeroComparedIdentifier(
	node: t.Node | null | undefined,
): string | null {
	if (!t.isBinaryExpression(node, { operator: "===" })) return null;
	if (
		t.isIdentifier(node.left) &&
		t.isNumericLiteral(node.right, { value: 0 })
	) {
		return node.left.name;
	}
	if (
		t.isNumericLiteral(node.left, { value: 0 }) &&
		t.isIdentifier(node.right)
	) {
		return node.right.name;
	}
	return null;
}

function hasStockRunnerSuccessContract(
	callPath: NodePath<t.CallExpression>,
): boolean {
	const awaitPath = callPath.parentPath;
	if (
		!awaitPath?.isAwaitExpression() ||
		awaitPath.node.argument !== callPath.node
	) {
		return false;
	}
	const declarationPath = awaitPath.parentPath;
	if (
		!declarationPath?.isVariableDeclarator() ||
		declarationPath.node.init !== awaitPath.node ||
		!t.isObjectPattern(declarationPath.node.id)
	) {
		return false;
	}
	const codeName = getObjectPatternBindingName(declarationPath.node.id, "code");
	if (!codeName) return false;
	const codeBinding = declarationPath.scope.getBinding(codeName);
	if (!codeBinding?.constant || codeBinding.constantViolations.length !== 0) {
		return false;
	}

	const declarationStatementPath = declarationPath.parentPath;
	if (
		!declarationStatementPath?.isVariableDeclaration() ||
		declarationStatementPath.node.declarations.length !== 1 ||
		declarationStatementPath.node.declarations[0] !== declarationPath.node
	) {
		return false;
	}
	const blockPath = declarationStatementPath.parentPath;
	if (!blockPath?.isBlockStatement()) return false;
	const statementPaths = blockPath.get("body");
	const declarationIndex = statementPaths.findIndex(
		(statementPath) => statementPath.node === declarationStatementPath.node,
	);
	const successReturnPath = statementPaths[declarationIndex + 1];
	if (declarationIndex < 0 || !successReturnPath?.isReturnStatement()) {
		return false;
	}
	const comparedName = getZeroComparedIdentifier(
		successReturnPath.node.argument,
	);
	return (
		comparedName !== null &&
		successReturnPath.scope.getBinding(comparedName) === codeBinding
	);
}

function getDbusRevealBindings(
	path: NodePath<t.CallExpression>,
): StockRevealBindings | null {
	const { node } = path;
	if (!t.isIdentifier(node.callee)) return null;
	if (node.arguments.length !== 2) return null;
	if (!isStringLiteral(node.arguments[0] as t.Node, DBUS_COMMAND)) return null;

	const args = node.arguments[1];
	if (!t.isArrayExpression(args)) return null;
	if (
		!args.elements.some((element) =>
			isStringLiteral(element as t.Node, FILE_MANAGER_METHOD),
		)
	) {
		return null;
	}

	const functionPath = path.getFunctionParent();
	if (!functionPath?.isFunctionDeclaration()) {
		return null;
	}
	if (!hasStockRunnerSuccessContract(path)) return null;
	const revealName = getCallableName(functionPath);
	if (!revealName) return null;
	const revealBindingNode = path.scope.getBinding(revealName)?.path.node;
	const runnerBindingNode =
		path.scope.getBinding(node.callee.name)?.path.node ?? null;
	if (!revealBindingNode) return null;
	return {
		revealName,
		revealBindingNode,
		runnerName: node.callee.name,
		runnerBindingNode,
	};
}

function isTrueValue(node: t.Node | null | undefined): boolean {
	return (
		t.isBooleanLiteral(node, { value: true }) ||
		(t.isUnaryExpression(node, { operator: "!" }) &&
			t.isNumericLiteral(node.argument, { value: 0 }))
	);
}

function hasStockRunnerNoThrowSuccessContract(
	callPath: NodePath<t.CallExpression>,
): boolean {
	const awaitPath = callPath.parentPath;
	if (
		!awaitPath?.isAwaitExpression() ||
		awaitPath.node.argument !== callPath.node
	) {
		return false;
	}
	const sequencePath = awaitPath.parentPath;
	if (
		!sequencePath?.isSequenceExpression() ||
		sequencePath.node.expressions.length !== 2 ||
		sequencePath.node.expressions[0] !== awaitPath.node ||
		!isTrueValue(sequencePath.node.expressions[1])
	) {
		return false;
	}
	const returnPath = sequencePath.parentPath;
	if (
		!returnPath?.isReturnStatement() ||
		returnPath.node.argument !== sequencePath.node
	) {
		return false;
	}
	const blockPath = returnPath.parentPath;
	if (
		!blockPath?.isBlockStatement() ||
		blockPath.node.body.length !== 1 ||
		blockPath.node.body[0] !== returnPath.node
	) {
		return false;
	}
	const tryPath = blockPath.parentPath;
	if (
		!tryPath?.isTryStatement() ||
		tryPath.node.block !== blockPath.node ||
		tryPath.node.finalizer ||
		tryPath.node.handler?.body.body.length !== 1
	) {
		return false;
	}
	return isFalseReturn(tryPath.node.handler.body.body[0]);
}

function isExplorerSelectArguments(
	node: t.Node | null | undefined,
	filePathName: string,
): boolean {
	if (!t.isArrayExpression(node) || node.elements.length !== 1) return false;
	const argument = node.elements[0];
	if (
		!t.isTemplateLiteral(argument) ||
		argument.expressions.length !== 1 ||
		argument.quasis.length !== 2 ||
		argument.quasis[0]?.value.raw !== "/select," ||
		argument.quasis[1]?.value.raw !== ""
	) {
		return false;
	}
	return t.isIdentifier(argument.expressions[0], { name: filePathName });
}

function getWindowsExplorerRevealBindings(
	path: NodePath<t.CallExpression>,
): StockRevealBindings | null {
	const { node } = path;
	if (!t.isIdentifier(node.callee)) return null;
	if (node.arguments.length !== 2) return null;
	if (!isStringLiteral(node.arguments[0] as t.Node, "explorer")) return null;

	const functionPath = path.getFunctionParent();
	if (
		!functionPath?.isFunctionDeclaration() ||
		functionPath.node.params.length !== 1
	) {
		return null;
	}
	const filePathParam = functionPath.node.params[0];
	if (
		!t.isIdentifier(filePathParam) ||
		!isExplorerSelectArguments(
			node.arguments[1] as t.Node,
			filePathParam.name,
		) ||
		!hasStockRunnerNoThrowSuccessContract(path)
	) {
		return null;
	}

	const revealName = getCallableName(functionPath);
	if (!revealName) return null;
	const revealBindingNode = path.scope.getBinding(revealName)?.path.node;
	const runnerBindingNode =
		path.scope.getBinding(node.callee.name)?.path.node ?? null;
	if (!revealBindingNode) return null;
	return {
		revealName,
		revealBindingNode,
		runnerName: node.callee.name,
		runnerBindingNode,
	};
}

function getStockRevealBindings(
	path: NodePath<t.CallExpression>,
): StockRevealBindings | null {
	return getDbusRevealBindings(path) ?? getWindowsExplorerRevealBindings(path);
}

function addStockRevealBinding(
	bindings: StockRevealBindings[],
	candidate: StockRevealBindings,
): void {
	if (
		bindings.some(
			(binding) =>
				binding.revealBindingNode === candidate.revealBindingNode &&
				binding.runnerBindingNode === candidate.runnerBindingNode,
		)
	) {
		return;
	}
	bindings.push(candidate);
}

function getComparedIdentifier(
	node: t.Node | null | undefined,
	stringValue: string,
): string | null {
	if (!t.isBinaryExpression(node, { operator: "===" })) return null;
	if (t.isIdentifier(node.left) && isStringLiteral(node.right, stringValue)) {
		return node.left.name;
	}
	if (isStringLiteral(node.left, stringValue) && t.isIdentifier(node.right)) {
		return node.right.name;
	}
	return null;
}

function isFileUrlToPathCall(
	node: t.Node | null | undefined,
	inputName: string,
	path?: NodePath<t.CallExpression>,
): node is t.CallExpression {
	if (!t.isCallExpression(node) || node.arguments.length !== 1) return false;
	let isDirectImport = false;
	if (t.isIdentifier(node.callee) && path) {
		const binding = path.scope.getBinding(node.callee.name);
		if (binding?.path.isImportSpecifier()) {
			isDirectImport =
				getObjectKeyName(binding.path.node.imported) === "fileURLToPath";
		}
	}
	const isFileUrlDecoder =
		(t.isMemberExpression(node.callee) &&
			getMemberPropertyName(node.callee) === "fileURLToPath") ||
		isDirectImport;
	if (!isFileUrlDecoder) return false;
	return t.isIdentifier(node.arguments[0], { name: inputName });
}

interface GuardedFileDispatchFlow {
	awaitNode: t.AwaitExpression;
	callNode: t.CallExpression;
	callPath: NodePath<t.CallExpression>;
	filePathExpression: t.Identifier;
}

function getGuardedFileDispatchFlow(
	statement: t.Statement,
	inputName: string,
	callPaths: Map<t.CallExpression, NodePath<t.CallExpression>>,
): GuardedFileDispatchFlow | null {
	if (
		!t.isTryStatement(statement) ||
		statement.finalizer ||
		statement.block.body.length !== 3 ||
		statement.handler?.body.body.length !== 1 ||
		!isFalseReturn(statement.handler.body.body[0])
	) {
		return null;
	}

	const [decodeStatement, rejectStatement, dispatchStatement] =
		statement.block.body;
	if (
		!t.isVariableDeclaration(decodeStatement) ||
		decodeStatement.declarations.length !== 1
	) {
		return null;
	}
	const [decodeDeclaration] = decodeStatement.declarations;
	if (
		!t.isIdentifier(decodeDeclaration.id) ||
		!t.isCallExpression(decodeDeclaration.init)
	) {
		return null;
	}
	const decodeCallPath = callPaths.get(decodeDeclaration.init);
	if (
		!decodeCallPath ||
		!isFileUrlToPathCall(decodeDeclaration.init, inputName, decodeCallPath)
	) {
		return null;
	}
	const decodedPathBinding = decodeCallPath?.scope.getBinding(
		decodeDeclaration.id.name,
	);
	if (
		!decodedPathBinding?.constant ||
		decodedPathBinding.constantViolations.length !== 0 ||
		decodedPathBinding.path.node !== decodeDeclaration
	) {
		return null;
	}

	if (
		!t.isIfStatement(rejectStatement) ||
		rejectStatement.alternate ||
		!isFalseReturn(rejectStatement.consequent)
	) {
		return null;
	}
	const rejectCalls: t.CallExpression[] = [];
	t.traverseFast(rejectStatement.test, (node) => {
		if (t.isCallExpression(node)) rejectCalls.push(node);
	});
	if (
		rejectCalls.length === 0 ||
		rejectCalls.some((rejectCall) => {
			if (
				!t.isIdentifier(rejectCall.callee) ||
				rejectCall.arguments.length !== 1 ||
				!t.isIdentifier(rejectCall.arguments[0])
			) {
				return true;
			}
			const rejectCallPath = callPaths.get(rejectCall);
			return (
				!rejectCallPath ||
				rejectCallPath.scope.getBinding(rejectCall.arguments[0].name) !==
					decodedPathBinding
			);
		})
	) {
		return null;
	}

	if (
		!t.isReturnStatement(dispatchStatement) ||
		!t.isAwaitExpression(dispatchStatement.argument) ||
		!t.isCallExpression(dispatchStatement.argument.argument)
	) {
		return null;
	}
	const awaitNode = dispatchStatement.argument as t.AwaitExpression;
	const callNode = awaitNode.argument as t.CallExpression;
	const callPath = callPaths.get(callNode);
	const filePathExpression = callNode.arguments[0];
	if (
		!callPath ||
		!t.isIdentifier(filePathExpression) ||
		callPath.scope.getBinding(filePathExpression.name) !== decodedPathBinding
	) {
		return null;
	}

	return { awaitNode, callNode, callPath, filePathExpression };
}

function isNewUrlExpression(
	node: t.Node | null | undefined,
	inputName: string,
): boolean {
	return (
		t.isNewExpression(node) &&
		t.isIdentifier(node.callee, { name: "URL" }) &&
		node.arguments.length === 1 &&
		t.isIdentifier(node.arguments[0], { name: inputName })
	);
}

function getProtocolObjectName(node: t.Node | null | undefined): string | null {
	if (!t.isMemberExpression(node)) return null;
	if (getMemberPropertyName(node) !== "protocol") return null;
	return t.isIdentifier(node.object) ? node.object.name : null;
}

function isFalseReturn(
	node: t.Node | null | undefined,
): node is t.ReturnStatement {
	return (
		t.isReturnStatement(node) &&
		(t.isBooleanLiteral(node.argument, { value: false }) ||
			(t.isUnaryExpression(node.argument, { operator: "!" }) &&
				t.isNumericLiteral(node.argument.argument, { value: 1 })))
	);
}

function isExactEmptyHostGuard(
	node: t.Node | null | undefined,
	urlName: string,
): boolean {
	if (!t.isIfStatement(node) || node.alternate) return false;
	if (!t.isBinaryExpression(node.test, { operator: "!==" })) return false;
	if (
		!t.isMemberExpression(node.test.left) ||
		!t.isIdentifier(node.test.left.object, { name: urlName }) ||
		getMemberPropertyName(node.test.left) !== "host" ||
		!isStringLiteral(node.test.right, "")
	) {
		return false;
	}
	return isFalseReturn(node.consequent);
}

const NON_ALLOWLISTED_WARNING =
	"[hyperlink] refusing to dispatch clicked link with non-allowlisted scheme";

function containsNonAllowlistedWarning(node: t.Node): boolean {
	let found = false;
	t.traverseFast(node, (child) => {
		if (
			(t.isStringLiteral(child) &&
				child.value.includes(NON_ALLOWLISTED_WARNING)) ||
			(t.isTemplateElement(child) &&
				child.value.raw.includes(NON_ALLOWLISTED_WARNING))
		) {
			found = true;
		}
	});
	return found;
}

function isNonAllowlistedWarningNode(
	node: t.Node | null | undefined,
): node is t.StringLiteral | t.TemplateElement {
	return (
		(t.isStringLiteral(node) && node.value.includes(NON_ALLOWLISTED_WARNING)) ||
		(t.isTemplateElement(node) &&
			node.value.raw.includes(NON_ALLOWLISTED_WARNING))
	);
}

function isWarnLevelOptions(node: t.Node | null | undefined): boolean {
	if (!t.isObjectExpression(node) || node.properties.length !== 1) return false;
	const property = node.properties[0];
	return (
		t.isObjectProperty(property) &&
		getObjectKeyName(property.key) === "level" &&
		isStringLiteral(property.value as t.Node, "warn")
	);
}

function getAllowlistLoggerCall(
	node: t.Node | null | undefined,
	protocolName: string,
): AllowlistLoggerCall | null {
	if (!t.isIfStatement(node)) return null;
	if (!t.isUnaryExpression(node.test, { operator: "!" })) return null;
	const call = node.test.argument;
	if (!t.isCallExpression(call) || call.arguments.length !== 1) return null;
	if (
		!t.isMemberExpression(call.callee) ||
		getMemberPropertyName(call.callee) !== "has" ||
		!t.isIdentifier(call.arguments[0], { name: protocolName })
	) {
		return null;
	}

	const loggerCalls: AllowlistLoggerCall[] = [];
	t.traverseFast(node.consequent, (child) => {
		if (
			!t.isCallExpression(child) ||
			!t.isIdentifier(child.callee) ||
			child.arguments.length !== 2 ||
			!containsNonAllowlistedWarning(child.arguments[0] as t.Node) ||
			!isWarnLevelOptions(child.arguments[1] as t.Node)
		) {
			return;
		}
		loggerCalls.push({
			callNode: child,
			loggerName: child.callee.name,
		});
	});
	return loggerCalls.length === 1 ? loggerCalls[0] : null;
}

function analyzeDispatcher(
	path: NodePath<t.FunctionDeclaration>,
): DispatcherAnalysis | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	const containerBody = path.parentPath?.isProgram()
		? path.parentPath.node.body
		: path.parentPath?.isBlockStatement()
			? path.parentPath.node.body
			: null;
	if (!containerBody) return null;
	const firstParam = path.node.params[0];
	if (!t.isIdentifier(firstParam)) return null;
	const inputName = firstParam.name;

	const urlNames = new Set<string>();
	const protocolReads: Array<{ protocolName: string; urlName: string }> = [];
	const callPaths = new Map<t.CallExpression, NodePath<t.CallExpression>>();

	path.traverse({
		Function(innerPath) {
			innerPath.skip();
		},
		CallExpression(callPath) {
			callPaths.set(callPath.node, callPath);
		},
		VariableDeclarator(declarationPath) {
			const { id, init } = declarationPath.node;
			if (!t.isIdentifier(id)) return;
			if (isNewUrlExpression(init, inputName)) urlNames.add(id.name);
			const urlName = getProtocolObjectName(init);
			if (urlName) {
				protocolReads.push({ protocolName: id.name, urlName });
			}
		},
		AssignmentExpression(assignmentPath) {
			const { left, right } = assignmentPath.node;
			if (!t.isIdentifier(left)) return;
			if (isNewUrlExpression(right, inputName)) urlNames.add(left.name);
			const urlName = getProtocolObjectName(right);
			if (urlName) {
				protocolReads.push({ protocolName: left.name, urlName });
			}
		},
	});

	if (urlNames.size !== 1) return null;
	const urlName = urlNames.values().next().value as string;
	const protocolNames = new Set(
		protocolReads
			.filter((read) => read.urlName === urlName)
			.map((read) => read.protocolName),
	);
	if (protocolNames.size !== 1) return null;
	const protocolName = protocolNames.values().next().value as string;

	const body = path.node.body.body;
	const fileBranchIndexes = body.flatMap((statement, index) =>
		t.isIfStatement(statement) &&
		getComparedIdentifier(statement.test, "file:") === protocolName &&
		t.isBlockStatement(statement.consequent)
			? [index]
			: [],
	);
	if (fileBranchIndexes.length !== 1) return null;
	const fileBranchIndex = fileBranchIndexes[0];
	const fileBranch = body[fileBranchIndex] as t.IfStatement & {
		consequent: t.BlockStatement;
	};
	const fileBody = fileBranch.consequent.body;
	const hostGuardIndexes = fileBody.flatMap((statement, index) =>
		isExactEmptyHostGuard(statement, urlName) ? [index] : [],
	);
	if (hostGuardIndexes.length !== 1) return null;

	const dispatchFlows = fileBody.flatMap((statement, index) => {
		if (index <= hostGuardIndexes[0]) return [];
		const flow = getGuardedFileDispatchFlow(statement, inputName, callPaths);
		return flow ? [flow] : [];
	});
	if (dispatchFlows.length !== 1) return null;
	const loggerCalls = body.slice(fileBranchIndex + 1).flatMap((statement) => {
		const loggerCall = getAllowlistLoggerCall(statement, protocolName);
		return loggerCall ? [loggerCall] : [];
	});
	if (loggerCalls.length !== 1) return null;
	const loggerName = loggerCalls[0].loggerName;
	const loggerCallPath = callPaths.get(loggerCalls[0].callNode);
	const loggerBindingNode =
		loggerCallPath?.scope.getBinding(loggerName)?.path.node;
	if (!loggerBindingNode) return null;

	const helperCalls: HelperDispatchCall[] = [];
	const stockCalls: StockDispatchCall[] = [];
	const { awaitNode, callNode, callPath, filePathExpression } =
		dispatchFlows[0];
	if (callPath.scope.getBinding(loggerName)?.path.node !== loggerBindingNode) {
		return null;
	}

	if (t.isIdentifier(callNode.callee) && callNode.callee.name === HELPER_NAME) {
		const stockOpenName = t.isIdentifier(callNode.arguments[1])
			? callNode.arguments[1].name
			: null;
		const runnerName = t.isIdentifier(callNode.arguments[2])
			? callNode.arguments[2].name
			: null;
		const helperLoggerName = t.isIdentifier(callNode.arguments[3])
			? callNode.arguments[3].name
			: null;
		helperCalls.push({
			awaitNode,
			callNode,
			filePathExpression,
			stockOpenName,
			stockBindingNode: stockOpenName
				? (callPath.scope.getBinding(stockOpenName)?.path.node ?? null)
				: null,
			loggerName: helperLoggerName,
			loggerBindingNode: helperLoggerName
				? (callPath.scope.getBinding(helperLoggerName)?.path.node ?? null)
				: null,
			runnerName,
			runnerBindingNode: runnerName
				? (callPath.scope.getBinding(runnerName)?.path.node ?? null)
				: null,
		});
	} else if (
		t.isIdentifier(callNode.callee) &&
		callNode.arguments.length === 1
	) {
		stockCalls.push({
			awaitNode,
			callNode,
			filePathExpression,
			stockOpenName: callNode.callee.name,
			stockBindingNode:
				callPath.scope.getBinding(callNode.callee.name)?.path.node ?? null,
		});
	}

	return {
		containerBody,
		functionNode: path.node,
		helperCalls,
		loggerBindingNode,
		loggerName,
		stockCalls,
	};
}

function recordDispatcherCandidate(
	path: NodePath<t.StringLiteral | t.TemplateElement>,
	seen: Set<t.FunctionDeclaration>,
	dispatchers: DispatcherAnalysis[],
): void {
	if (!isNonAllowlistedWarningNode(path.node)) return;
	const functionPath = path.getFunctionParent();
	if (!functionPath?.isFunctionDeclaration()) return;
	if (seen.has(functionPath.node)) return;
	seen.add(functionPath.node);
	const analysis = analyzeDispatcher(functionPath);
	if (analysis) dispatchers.push(analysis);
}

function buildHelperStatement(): t.FunctionDeclaration {
	const ast = parse(HELPER_SOURCE);
	const statement = ast.program.body[0];
	if (!t.isFunctionDeclaration(statement) || !statement.async) {
		throw new Error(
			"file-link-targets helper source did not parse as an async function",
		);
	}
	return statement;
}

function buildHelperCall(
	stockCall: StockDispatchCall,
	bindings: StockRevealBindings,
	dispatcher: DispatcherAnalysis,
): t.CallExpression {
	return t.callExpression(t.identifier(HELPER_NAME), [
		t.cloneNode(stockCall.filePathExpression),
		t.identifier(bindings.revealName),
		t.identifier(bindings.runnerName),
		t.identifier(dispatcher.loggerName),
	]);
}

function createFileLinkPasses(): PatchAstPass[] {
	const seenDispatcherNodes = new Set<t.FunctionDeclaration>();
	const state: FileLinkPassState = {
		bindingCandidates: [],
		bindings: undefined,
		dispatcherCandidates: [],
		dispatcherCount: 0,
		helperCount: 0,
		patchedCount: 0,
	};

	return [
		{
			pass: "discover",
			visitor: {
				CallExpression(path) {
					const candidate = getStockRevealBindings(path);
					if (!candidate) return;
					addStockRevealBinding(state.bindingCandidates, candidate);
				},
				FunctionDeclaration(path) {
					if (path.node.id?.name === HELPER_NAME) {
						state.helperCount += 1;
					}
				},
				StringLiteral(path) {
					recordDispatcherCandidate(
						path,
						seenDispatcherNodes,
						state.dispatcherCandidates,
					);
				},
				TemplateElement(path) {
					recordDispatcherCandidate(
						path,
						seenDispatcherNodes,
						state.dispatcherCandidates,
					);
				},
				Program: {
					exit() {
						if (state.bindingCandidates.length === 1) {
							state.bindings = state.bindingCandidates[0];
						}
						state.dispatcherCount = state.dispatcherCandidates.length;
					},
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (!state.bindings) return;
						if (state.dispatcherCandidates.length !== 1) return;
						const analysis = state.dispatcherCandidates[0];
						if (
							analysis.helperCalls.length === 1 &&
							analysis.stockCalls.length === 0 &&
							state.helperCount === 1
						) {
							const helperCall = analysis.helperCalls[0];
							if (
								helperCall.callNode.arguments.length === 4 &&
								helperCall.stockBindingNode ===
									state.bindings.revealBindingNode &&
								helperCall.runnerBindingNode ===
									state.bindings.runnerBindingNode &&
								helperCall.loggerBindingNode === analysis.loggerBindingNode
							) {
								state.patchedCount = 1;
							}
							return;
						}
						if (
							analysis.stockCalls.length !== 1 ||
							analysis.helperCalls.length !== 0 ||
							state.helperCount !== 0
						) {
							return;
						}

						const stockCall = analysis.stockCalls[0];
						if (
							stockCall.stockBindingNode !== state.bindings.revealBindingNode ||
							stockCall.awaitNode.argument !== stockCall.callNode
						) {
							return;
						}
						const functionIndex = analysis.containerBody.indexOf(
							analysis.functionNode,
						);
						if (functionIndex < 0) return;

						stockCall.awaitNode.argument = buildHelperCall(
							stockCall,
							state.bindings,
							analysis,
						);
						analysis.containerBody.splice(
							functionIndex,
							0,
							buildHelperStatement(),
						);
						state.patchedCount = 1;
					},
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (!state.bindings) {
							console.warn(
								"file-link-targets: Could not uniquely resolve stock file dispatch dependencies",
							);
						}
						if (state.dispatcherCount !== 1) {
							console.warn(
								`file-link-targets: Expected one stock file dispatcher, found ${state.dispatcherCount}`,
							);
						}
						if (state.patchedCount !== 1) {
							console.warn(
								`file-link-targets: Expected one patched file dispatcher, found ${state.patchedCount}`,
							);
						}
					},
				},
			},
		},
	];
}

interface VerificationEvidence {
	bindings: StockRevealBindings[];
	dispatchers: DispatcherAnalysis[];
	helpers: t.FunctionDeclaration[];
}

function collectVerificationEvidence(ast: t.File): VerificationEvidence {
	const seenDispatcherNodes = new Set<t.FunctionDeclaration>();
	const evidence: VerificationEvidence = {
		bindings: [],
		dispatchers: [],
		helpers: [],
	};
	traverse(ast, {
		CallExpression(path) {
			const candidate = getStockRevealBindings(path);
			if (candidate) addStockRevealBinding(evidence.bindings, candidate);
		},
		FunctionDeclaration(path) {
			if (path.node.id?.name === HELPER_NAME) {
				evidence.helpers.push(path.node);
			}
		},
		StringLiteral(path) {
			recordDispatcherCandidate(
				path,
				seenDispatcherNodes,
				evidence.dispatchers,
			);
		},
		TemplateElement(path) {
			recordDispatcherCandidate(
				path,
				seenDispatcherNodes,
				evidence.dispatchers,
			);
		},
	});
	return evidence;
}

function verifyHelper(helpers: t.FunctionDeclaration[]): true | string {
	if (helpers.length !== 1) {
		return `Expected one file-open helper, found ${helpers.length}`;
	}
	if (!t.isNodesEquivalent(helpers[0], buildHelperStatement())) {
		return "File-open helper no longer matches the canonical implementation";
	}
	return true;
}

function verifyDispatcher(evidence: VerificationEvidence): true | string {
	if (evidence.bindings.length !== 1) {
		return `Expected one stock file dispatch dependency set, found ${evidence.bindings.length}`;
	}
	if (evidence.dispatchers.length !== 1) {
		return `Expected one stock file dispatcher, found ${evidence.dispatchers.length}`;
	}
	const bindings = evidence.bindings[0];
	const dispatcher = evidence.dispatchers[0];
	if (dispatcher.stockCalls.length !== 0) {
		return "Stock file dispatcher still bypasses the enhanced opener";
	}
	if (dispatcher.helperCalls.length !== 1) {
		return `Expected one enhanced file dispatch call, found ${dispatcher.helperCalls.length}`;
	}

	const helperCall = dispatcher.helperCalls[0];
	if (!helperCall.filePathExpression) {
		return "Enhanced file dispatch no longer receives the decoded file path";
	}
	if (helperCall.callNode.arguments.length !== 4) {
		return "Enhanced file dispatch argument contract changed";
	}
	if (helperCall.stockBindingNode !== bindings.revealBindingNode) {
		return "Enhanced file dispatch no longer preserves the stock fallback";
	}
	if (helperCall.runnerBindingNode !== bindings.runnerBindingNode) {
		return "Enhanced file dispatch no longer uses the stock process runner";
	}
	if (helperCall.loggerBindingNode !== dispatcher.loggerBindingNode) {
		return "Enhanced file dispatch no longer uses the stock warning channel";
	}
	return true;
}

export const fileLinkTargets: Patch = {
	tag: "file-link-targets",

	astPasses: () => createFileLinkPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during file-link-targets verification";
		}
		const evidence = collectVerificationEvidence(verifyAst);
		const helperResult = verifyHelper(evidence.helpers);
		if (helperResult !== true) return helperResult;
		return verifyDispatcher(evidence);
	},
};
