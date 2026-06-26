import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
	hasObjectKeyName,
	isElementCall,
} from "./ast-helpers.js";

const HELPER_NAME = "_ccEnhancedFileHref";

type FileLinkEnv = Record<string, string | undefined>;

export function resolveFileLinkHrefForEnv(
	filePath: string,
	fallbackHref: string,
	env: FileLinkEnv,
): string {
	try {
		const mode = env.CLAUDE_CODE_FILE_LINK_MODE || "wsl-file";
		if (
			mode === "default" ||
			mode === "vanilla" ||
			mode === "off" ||
			mode === "none"
		) {
			return fallbackHref;
		}
		if (typeof filePath !== "string" || filePath.charAt(0) !== "/") {
			return fallbackHref;
		}

		const windowsDrive = /^\/mnt\/([A-Za-z])\/(.+)$/.exec(filePath);
		if (windowsDrive) {
			const drivePath =
				`${windowsDrive[1].toLowerCase()}:/` +
				windowsDrive[2].split("/").map(encodeURIComponent).join("/");
			if (mode === "wsl-file" || mode === "file") return `file:///${drivePath}`;
			if (mode === "vscode") return `vscode://file/${drivePath}`;
			if (mode === "vscode-remote") return `vscode://file/${drivePath}`;
			if (mode === "zed") return `zed://file/${drivePath}`;
			const driveScheme = env.CLAUDE_CODE_FILE_LINK_SCHEME || "";
			if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(driveScheme)) {
				return `${driveScheme}://file/${drivePath}`;
			}
			return fallbackHref;
		}

		const distro =
			env.CLAUDE_CODE_FILE_LINK_WSL_DISTRO || env.WSL_DISTRO_NAME || "";
		if (!(distro || env.WSL_INTEROP || env.WT_SESSION)) return fallbackHref;
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		const encodedDistro = encodeURIComponent(distro || "Ubuntu");
		const uncPath = `//wsl.localhost/${encodedDistro}${encodedPath}`;
		if (mode === "wsl-file" || mode === "file") return `file:${uncPath}`;
		if (mode === "vscode") return `vscode://file${uncPath}`;
		if (mode === "vscode-remote") {
			return `vscode://vscode-remote/wsl+${encodedDistro}${encodedPath}`;
		}
		if (mode === "zed") return `zed://file${uncPath}`;
		const scheme = env.CLAUDE_CODE_FILE_LINK_SCHEME || "";
		if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
			return `${scheme}://file${uncPath}`;
		}
	} catch {}
	return fallbackHref;
}

const HELPER_SOURCE = `
function ${HELPER_NAME}(filePath, fallbackHref) {
  try {
    var env = typeof process !== "undefined" && process.env ? process.env : {};
    var mode = env.CLAUDE_CODE_FILE_LINK_MODE || "wsl-file";
    if (mode === "default" || mode === "vanilla" || mode === "off" || mode === "none") return fallbackHref;
    if (typeof filePath !== "string" || filePath.charAt(0) !== "/") return fallbackHref;

    var windowsDrive = /^\\/mnt\\/([A-Za-z])\\/(.+)$/.exec(filePath);
    if (windowsDrive) {
      var drivePath = windowsDrive[1].toLowerCase() + ":/" + windowsDrive[2].split("/").map(encodeURIComponent).join("/");
      if (mode === "wsl-file" || mode === "file") return "file:///" + drivePath;
      if (mode === "vscode") return "vscode://file/" + drivePath;
      if (mode === "vscode-remote") return "vscode://file/" + drivePath;
      if (mode === "zed") return "zed://file/" + drivePath;
      var driveScheme = env.CLAUDE_CODE_FILE_LINK_SCHEME || "";
      if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(driveScheme)) return driveScheme + "://file/" + drivePath;
      return fallbackHref;
    }

    var distro = env.CLAUDE_CODE_FILE_LINK_WSL_DISTRO || env.WSL_DISTRO_NAME || "";
    if (!(distro || env.WSL_INTEROP || env.WT_SESSION)) return fallbackHref;
    var encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    var encodedDistro = encodeURIComponent(distro || "Ubuntu");
    var uncPath = "//wsl.localhost/" + encodedDistro + encodedPath;
    if (mode === "wsl-file" || mode === "file") return "file:" + uncPath;
    if (mode === "vscode") return "vscode://file" + uncPath;
    if (mode === "vscode-remote") return "vscode://vscode-remote/wsl+" + encodedDistro + encodedPath;
    if (mode === "zed") return "zed://file" + uncPath;
    var scheme = env.CLAUDE_CODE_FILE_LINK_SCHEME || "";
    if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return scheme + "://file" + uncPath;
  } catch {}
  return fallbackHref;
}
`;

function getObjectPatternBinding(
	pattern: t.ObjectPattern,
	keyName: string,
): string | null {
	for (const prop of pattern.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		if (t.isIdentifier(prop.value)) return prop.value.name;
		if (t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left)) {
			return prop.value.left.name;
		}
	}
	return null;
}

function getFilePathBindingFromFunction(
	path: any,
): { filePathBinding: string; destructuredFrom: string } | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	const firstParam = path.node.params[0];
	if (!t.isIdentifier(firstParam)) return null;
	const paramName = firstParam.name;

	for (const statement of path.node.body.body) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			if (!t.isObjectPattern(declaration.id)) continue;
			if (!t.isIdentifier(declaration.init, { name: paramName })) continue;
			if (!getObjectPatternBinding(declaration.id, "children")) continue;
			const filePathBinding = getObjectPatternBinding(
				declaration.id,
				"filePath",
			);
			if (filePathBinding) {
				return { filePathBinding, destructuredFrom: paramName };
			}
		}
	}

	return null;
}

function functionCallsPathToFileURL(
	path: any,
	filePathBinding: string,
): boolean {
	let found = false;
	path.traverse({
		Function(innerPath: any) {
			if (innerPath !== path) innerPath.skip();
		},
		CallExpression(callPath: any) {
			if (found) return;
			const callee = callPath.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (getMemberPropertyName(callee) !== "pathToFileURL") return;
			const firstArg = callPath.node.arguments[0];
			if (t.isIdentifier(firstArg, { name: filePathBinding })) {
				found = true;
			}
		},
	});
	return found;
}

function isHrefMember(
	node: t.Node | null | undefined,
): node is t.MemberExpression {
	return t.isMemberExpression(node) && getMemberPropertyName(node) === "href";
}

function buildHelperCall(
	filePathBinding: string,
	fallbackHref: t.Expression,
): t.CallExpression {
	return t.callExpression(t.identifier(HELPER_NAME), [
		t.identifier(filePathBinding),
		t.cloneNode(fallbackHref),
	]);
}

function buildHelperStatement(): t.Statement {
	const ast = parse(HELPER_SOURCE);
	const statement = ast.program.body[0];
	if (!t.isFunctionDeclaration(statement)) {
		throw new Error(
			"file-link-targets helper source did not parse as a function",
		);
	}
	return statement;
}

function patchFilePathComponent(path: any): boolean {
	const binding = getFilePathBindingFromFunction(path);
	if (!binding) return false;
	if (!functionCallsPathToFileURL(path, binding.filePathBinding)) return false;

	let patched = false;
	path.traverse({
		Function(innerPath: any) {
			if (innerPath !== path) innerPath.skip();
		},
		CallExpression(callPath: any) {
			if (!isElementCall(callPath.node)) return;
			const props = callPath.node.arguments[1];
			if (!t.isObjectExpression(props)) return;
			const hasChildrenProp = props.properties.some((prop) =>
				hasObjectKeyName(prop, "children"),
			);
			if (!hasChildrenProp) return;

			const urlProp = props.properties.find(
				(prop): prop is t.ObjectProperty =>
					t.isObjectProperty(prop) && getObjectKeyName(prop.key) === "url",
			);
			if (!urlProp) return;
			if (t.isCallExpression(urlProp.value)) {
				if (t.isIdentifier(urlProp.value.callee, { name: HELPER_NAME })) {
					patched = true;
				}
				return;
			}
			if (!isHrefMember(urlProp.value)) return;

			urlProp.value = buildHelperCall(
				binding.filePathBinding,
				urlProp.value as t.Expression,
			);
			patched = true;
		},
	});

	return patched;
}

function hasHelper(ast: t.File): boolean {
	let found = false;
	traverse(ast, {
		FunctionDeclaration(path) {
			if (path.node.id?.name === HELPER_NAME) {
				found = true;
				path.stop();
			}
		},
	});
	return found;
}

function createFileLinkTargetsMutator(ast: t.File): Visitor {
	let patched = false;
	return {
		FunctionDeclaration(path) {
			if (patched) return;
			if (!patchFilePathComponent(path)) return;
			patched = true;
			if (!hasHelper(ast)) {
				path.insertBefore(buildHelperStatement());
			}
		},
		Program: {
			exit() {
				if (!patched) {
					console.warn(
						"file-link-targets: Could not find file hyperlink component to patch",
					);
				}
			},
		},
	};
}

function verifyPatchedFilePathComponent(ast: t.File): true | string {
	let foundComponent = false;
	let foundPatchedUrl = false;
	let foundUnpatchedUrl = false;

	traverse(ast, {
		Function(path) {
			const binding = getFilePathBindingFromFunction(path);
			if (!binding) return;
			if (!functionCallsPathToFileURL(path, binding.filePathBinding)) return;
			foundComponent = true;

			path.traverse({
				Function(innerPath: any) {
					if (innerPath !== path) innerPath.skip();
				},
				ObjectProperty(propPath: any) {
					if (getObjectKeyName(propPath.node.key) !== "url") return;
					const value = propPath.node.value;
					if (
						t.isCallExpression(value) &&
						t.isIdentifier(value.callee, { name: HELPER_NAME }) &&
						value.arguments.length === 2 &&
						t.isIdentifier(value.arguments[0], {
							name: binding.filePathBinding,
						}) &&
						isHrefMember(value.arguments[1] as t.Node)
					) {
						foundPatchedUrl = true;
					} else if (isHrefMember(value)) {
						foundUnpatchedUrl = true;
					}
				},
			});
		},
	});

	if (!foundComponent) return "File hyperlink component not found";
	if (!foundPatchedUrl) {
		return "File hyperlink component did not route href through file-link helper";
	}
	if (foundUnpatchedUrl) {
		return "File hyperlink component still contains an unpatched href URL property";
	}
	return true;
}

export const fileLinkTargets: Patch = {
	tag: "file-link-targets",

	astPasses: (ast) => [
		{
			pass: "mutate",
			visitor: createFileLinkTargetsMutator(ast),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during file-link-targets verification";
		}
		if (!hasHelper(verifyAst)) return "Missing file-link href helper";
		return verifyPatchedFilePathComponent(verifyAst);
	},
};
