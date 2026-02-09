import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { isFalseLike } from "./ast-helpers.js";

/**
 * Disable tool output collapsing for search and read operations.
 *
 * By default, Claude Code collapses Bash search commands (rg, grep, find),
 * Bash read commands (cat, bat, head), and Read tool output into a summary
 * like "Searched for 1 pattern" or "Read 3 files".
 *
 * This patch makes all tool output visible by setting isCollapsible to false
 * in the E_1 function (the single choke point for collapse decisions).
 */
export const noCollapse: Patch = {
	tag: "no-collapse",

	ast: (ast) => {
		let patched = false;

		traverse.default(ast, {
			ObjectProperty(path) {
				// Find: isCollapsible: z.isSearch || z.isRead
				// Replace with: isCollapsible: !1
				if (
					!t.isIdentifier(path.node.key, { name: "isCollapsible" }) ||
					!t.isLogicalExpression(path.node.value, { operator: "||" })
				) {
					return;
				}

				const { left, right } = path.node.value;

				// Verify it's the right pattern: *.isSearch || *.isRead
				if (
					!t.isMemberExpression(left) ||
					!t.isIdentifier(left.property, { name: "isSearch" }) ||
					!t.isMemberExpression(right) ||
					!t.isIdentifier(right.property, { name: "isRead" })
				) {
					return;
				}

				// Replace with false
				path.node.value = t.booleanLiteral(false);
				patched = true;
				console.log("Disabled tool output collapsing");
			},
		});

		if (!patched) {
			console.warn("no-collapse: Could not find isCollapsible pattern");
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for no-collapse verification";

		let patchedCount = 0;
		let oldPatternCount = 0;
		let collapsiblePropCount = 0;

		traverse.default(ast, {
			ObjectExpression(path) {
				const props = path.node.properties.filter(
					(prop): prop is t.ObjectProperty => t.isObjectProperty(prop),
				);

				const collapsibleProp = props.find(
					(prop) =>
						t.isIdentifier(prop.key, { name: "isCollapsible" }) &&
						t.isExpression(prop.value),
				);
				if (!collapsibleProp || !t.isExpression(collapsibleProp.value)) return;

				// Require at least one of isSearch/isRead as context (OR, not AND)
				// so verify still works if upstream separates them into different objects
				const hasSearchOrRead = props.some(
					(prop) =>
						t.isIdentifier(prop.key, { name: "isSearch" }) ||
						t.isIdentifier(prop.key, { name: "isRead" }),
				);
				if (!hasSearchOrRead) return;
				collapsiblePropCount++;

				const value = collapsibleProp.value;
				if (
					t.isLogicalExpression(value, { operator: "||" }) &&
					t.isMemberExpression(value.left) &&
					t.isIdentifier(value.left.property, { name: "isSearch" }) &&
					t.isMemberExpression(value.right) &&
					t.isIdentifier(value.right.property, { name: "isRead" })
				) {
					oldPatternCount++;
					return;
				}

				if (isFalseLike(value)) {
					patchedCount++;
				}
			},
		});

		if (oldPatternCount > 0) {
			return "Original isCollapsible logic still present";
		}
		if (collapsiblePropCount === 0) {
			return "No isCollapsible property found near isSearch/isRead (upstream structure changed?)";
		}
		if (patchedCount < 1) {
			return "isCollapsible found but not set to false";
		}
		return true;
	},
};
