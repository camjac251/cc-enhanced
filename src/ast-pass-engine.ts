import traverse, { type NodePath, type Visitor } from "@babel/traverse";
import type * as t from "@babel/types";
import type { AstPassName, PatchAstPass } from "./types.js";

export interface PatchPassEntry {
	tag: string;
	pass: PatchAstPass;
}

function asCallable(value: unknown): ((path: NodePath<t.Node>) => void) | null {
	return typeof value === "function"
		? (value as (path: NodePath<t.Node>) => void)
		: null;
}

function splitVisitorKeys(key: string): string[] {
	return key.includes("|")
		? key
				.split("|")
				.map((k) => k.trim())
				.filter(Boolean)
		: [key];
}

type Handler = {
	tag: string;
	fn: (path: NodePath<t.Node>) => void;
};

function appendNodeHandler(
	merged: Visitor,
	key: string,
	phase: "enter" | "exit",
	handler: Handler,
) {
	const mergedMap = merged as Record<string, unknown>;
	const existing = mergedMap[key];
	if (!existing) {
		mergedMap[key] = {
			[phase]: [handler],
		};
		return;
	}

	if (typeof existing === "function") {
		const replacement = {
			enter: phase === "enter" ? [{ tag: "__legacy__", fn: existing }] : [],
			exit: phase === "exit" ? [{ tag: "__legacy__", fn: existing }] : [],
		};
		replacement[phase].push(handler);
		mergedMap[key] = replacement;
		return;
	}

	const existingObj = existing as Record<string, unknown>;
	const existingPhase = existingObj[phase];
	const handlers = Array.isArray(existingPhase)
		? (existingPhase as Handler[])
		: existingPhase
			? [
					{
						tag: "__legacy__",
						fn: existingPhase as (path: NodePath<t.Node>) => void,
					},
				]
			: [];
	handlers.push(handler);
	existingObj[phase] = handlers;
}

function appendRootHandler(
	merged: Visitor,
	phase: "enter" | "exit",
	handler: Handler,
) {
	const mergedMap = merged as Record<string, unknown>;
	const existing = mergedMap[phase];
	const handlers = Array.isArray(existing)
		? (existing as Handler[])
		: existing
			? [
					{
						tag: "__legacy__",
						fn: existing as (path: NodePath<t.Node>) => void,
					},
				]
			: [];
	handlers.push(handler);
	mergedMap[phase] = handlers;
}

function mergePassVisitors(entries: PatchPassEntry[]): Visitor {
	const merged: Visitor = {};

	for (const entry of entries) {
		const visitor = entry.pass.visitor;
		for (const [rawKey, rawValue] of Object.entries(
			visitor as Record<string, unknown>,
		)) {
			if (rawKey === "noScope") {
				(merged as Record<string, unknown>).noScope = rawValue;
				continue;
			}
			if (rawKey === "denylist") {
				(merged as Record<string, unknown>).denylist = rawValue;
				continue;
			}
			if (rawKey === "shouldSkip") {
				(merged as Record<string, unknown>).shouldSkip = rawValue;
				continue;
			}

			if (rawKey === "enter" || rawKey === "exit") {
				const fn = asCallable(rawValue);
				if (!fn) continue;
				appendRootHandler(merged, rawKey, { tag: entry.tag, fn });
				continue;
			}

			for (const key of splitVisitorKeys(rawKey)) {
				const callable = asCallable(rawValue);
				if (callable) {
					appendNodeHandler(merged, key, "enter", {
						tag: entry.tag,
						fn: callable,
					});
					continue;
				}
				if (!rawValue || typeof rawValue !== "object") continue;
				const obj = rawValue as Record<string, unknown>;
				const enterFn = asCallable(obj.enter);
				const exitFn = asCallable(obj.exit);
				if (enterFn) {
					appendNodeHandler(merged, key, "enter", {
						tag: entry.tag,
						fn: enterFn,
					});
				}
				if (exitFn) {
					appendNodeHandler(merged, key, "exit", {
						tag: entry.tag,
						fn: exitFn,
					});
				}
			}
		}
	}

	return merged;
}

function materializePassVisitor(
	merged: Visitor,
	onPatchError: (tag: string, error: Error) => void,
	globallyFailedTags: Set<string>,
): Visitor {
	const disabledTags = new Set<string>();
	const warnedStopTags = new Set<string>();
	const safeRun = (handlers: Handler[]) => (path: NodePath<t.Node>) => {
		for (const handler of handlers) {
			if (
				disabledTags.has(handler.tag) ||
				globallyFailedTags.has(handler.tag)
			) {
				continue;
			}
			const pathWithStop = path as NodePath<t.Node> & { stop: () => void };
			const originalStop = pathWithStop.stop.bind(pathWithStop);
			pathWithStop.stop = () => {
				if (!warnedStopTags.has(handler.tag)) {
					warnedStopTags.add(handler.tag);
					console.warn(
						`ast-pass-engine: ${handler.tag} called path.stop() during combined traversal; treating as path.skip()`,
					);
				}
				path.skip();
			};
			try {
				handler.fn(path);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				disabledTags.add(handler.tag);
				globallyFailedTags.add(handler.tag);
				onPatchError(handler.tag, err);
			} finally {
				pathWithStop.stop = originalStop;
			}
		}
	};

	const resolved: Visitor = {};
	for (const [key, rawValue] of Object.entries(
		merged as Record<string, unknown>,
	)) {
		if (key === "noScope" || key === "denylist" || key === "shouldSkip") {
			(resolved as Record<string, unknown>)[key] = rawValue;
			continue;
		}
		if (key === "enter" || key === "exit") {
			const handlers = rawValue as Handler[];
			(resolved as Record<string, unknown>)[key] = safeRun(handlers);
			continue;
		}

		if (!rawValue || typeof rawValue !== "object") continue;
		const value = rawValue as Record<string, unknown>;
		const enterHandlers = value.enter as Handler[] | undefined;
		const exitHandlers = value.exit as Handler[] | undefined;
		(resolved as Record<string, unknown>)[key] = {
			...(enterHandlers ? { enter: safeRun(enterHandlers) } : {}),
			...(exitHandlers ? { exit: safeRun(exitHandlers) } : {}),
		};
	}
	return resolved;
}

export async function runCombinedAstPasses(
	ast: t.File,
	entries: PatchPassEntry[],
	onPassStart: (pass: AstPassName, patchCount: number) => void,
	onPassEnd: (pass: AstPassName, patchCount: number) => void,
	onPatchError: (tag: string, error: Error) => void,
): Promise<void> {
	const passOrder: AstPassName[] = ["discover", "mutate", "finalize"];
	const globallyFailedTags = new Set<string>();
	for (const passName of passOrder) {
		const passEntries = entries.filter((entry) => entry.pass.pass === passName);
		if (passEntries.length === 0) continue;
		onPassStart(passName, passEntries.length);
		const merged = mergePassVisitors(passEntries);
		const safeVisitor = materializePassVisitor(
			merged,
			onPatchError,
			globallyFailedTags,
		);
		traverse.default(ast, safeVisitor);
		onPassEnd(passName, passEntries.length);
	}
}
