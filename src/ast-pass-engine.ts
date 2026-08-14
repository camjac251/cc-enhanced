import { createHash, type Hash } from "node:crypto";
import type * as t from "@babel/types";
import { VISITOR_KEYS } from "@babel/types";
import { type NodePath, traverse, type Visitor } from "./babel.js";
import type {
	AstPassName,
	PatchAstPass,
	PatchIssueCode,
	PatchOutcomeEvidence,
	PatchOutcomeRecorder,
} from "./types.js";

export function createPatchOutcomeRecorder(): PatchOutcomeRecorder {
	let matched = 0;
	let mutated = 0;
	let alreadySatisfied = 0;
	let verified: 0 | 1 = 0;
	const issues = new Set<PatchIssueCode>();

	return {
		recordMatch(outcome) {
			matched += 1;
			if (outcome === "mutated") mutated += 1;
			if (outcome === "already-satisfied") alreadySatisfied += 1;
		},
		recordIssue(code) {
			issues.add(code);
		},
		recordVerification(passed) {
			verified = passed ? 1 : 0;
		},
		snapshot(): PatchOutcomeEvidence {
			return {
				matched,
				mutated,
				alreadySatisfied,
				verified,
				issues: [...issues],
			};
		},
	};
}

export interface PatchPassEntry {
	tag: string;
	pass: PatchAstPass;
}

export type AstPassTelemetryLevel = "none" | "deep";

export interface AstPassTelemetry {
	handlerCalls: Record<string, Record<AstPassName, number>>;
	structuralHashes: Record<
		string,
		Record<
			AstPassName,
			{
				beforeSha256: string;
				afterSha256: string;
			}
		>
	>;
	overlaps: Array<{
		pass: AstPassName;
		nodeType: string;
		tags: string[];
		count: number;
	}>;
}

const SHAPE_ARRAY_SAMPLE_SIZE = 16;
const SHAPE_DEPTH = 2;
const TRAVERSAL_GLOBAL_VISITOR_OPTIONS = [
	"noScope",
	"denylist",
	"shouldSkip",
	"scope",
	"blacklist",
] as const;
const TRAVERSAL_GLOBAL_VISITOR_OPTION_SET = new Set<string>(
	TRAVERSAL_GLOBAL_VISITOR_OPTIONS,
);

function isNode(value: unknown): value is t.Node {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function boundedArrayShape(values: unknown[], depth: number): string {
	const describe = (index: number) =>
		boundedNodeDescription(values[index], depth);
	if (values.length <= SHAPE_ARRAY_SAMPLE_SIZE) {
		return `${values.length}:${values.map((_value, index) => describe(index)).join(",")}`;
	}
	const half = SHAPE_ARRAY_SAMPLE_SIZE / 2;
	const first = Array.from({ length: half }, (_value, index) =>
		describe(index),
	);
	const last = Array.from({ length: half }, (_value, index) =>
		describe(values.length - half + index),
	);
	return `${values.length}:${first.join(",")},...,${last.join(",")}`;
}

function boundedNodeDescription(value: unknown, depth: number): string {
	if (!isNode(value)) return "-";
	if (depth <= 0) return value.type;
	const node = value;
	const nodeRecord = node as unknown as Record<string, unknown>;
	const visitorKeys = VISITOR_KEYS[node.type] ?? [];
	const childShapes = visitorKeys.map((key) => {
		const child = nodeRecord[key];
		return Array.isArray(child)
			? `${key}=[${boundedArrayShape(child, depth - 1)}]`
			: `${key}=${boundedNodeDescription(child, depth - 1)}`;
	});
	return [node.type, ...childShapes].join("|");
}

export function boundedNodeShape(node: t.Node): string {
	return boundedNodeDescription(node, SHAPE_DEPTH);
}

function updateShapeHash(hash: Hash, node: t.Node | null): void {
	hash.update(node ? boundedNodeShape(node) : "<missing>");
	hash.update("\n");
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
			if (TRAVERSAL_GLOBAL_VISITOR_OPTION_SET.has(rawKey)) {
				throw new Error(
					`Unsupported traversal-global visitor option reached merge: ${rawKey}`,
				);
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
	passName: AstPassName,
	onPatchError: (tag: string, error: Error) => void,
	globallyFailedTags: Set<string>,
	collectActivity: boolean,
	collectShapes: boolean,
	onHandlerCall: (tag: string, pass: AstPassName) => void,
	onHandlerShape: (
		tag: string,
		pass: AstPassName,
		phase: "before" | "after",
		node: t.Node | null,
	) => void,
	onOverlap: (
		pass: AstPassName,
		nodeType: string,
		tags: readonly string[],
	) => void,
): Visitor {
	const disabledTags = new Set<string>();
	const warnedStopTags = new Set<string>();
	const safeRun = (handlers: Handler[]) => {
		return (path: NodePath<t.Node>) => {
			const initialNode = path.node;
			let firstExecutedTag: string | undefined;
			let overlappingTags: Set<string> | undefined;
			for (const handler of handlers) {
				if (
					disabledTags.has(handler.tag) ||
					globallyFailedTags.has(handler.tag)
				) {
					continue;
				}
				// If a prior merged handler replaced this node (via path.replaceWith
				// or similar), skip handlers that were registered for the original
				// node. They would otherwise inspect the replacement, which may be
				// a different kind, and crash on missing fields. Babel re-traverses
				// the replacement separately so kind-appropriate handlers still
				// fire on the new node.
				if (path.node !== initialNode) {
					continue;
				}
				if (collectActivity) {
					onHandlerCall(handler.tag, passName);
					if (collectShapes) {
						onHandlerShape(handler.tag, passName, "before", path.node);
					}
					if (firstExecutedTag === undefined) {
						firstExecutedTag = handler.tag;
					} else if (handler.tag !== firstExecutedTag) {
						overlappingTags ??= new Set([firstExecutedTag]);
						overlappingTags.add(handler.tag);
					}
				}
				const pathWithStop = path as NodePath<t.Node> & { stop: () => void };
				const hadOwnStop = Object.hasOwn(pathWithStop, "stop");
				const originalStop = pathWithStop.stop;
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
					if (collectShapes) {
						onHandlerShape(handler.tag, passName, "after", path.node);
					}
					if (hadOwnStop) {
						pathWithStop.stop = originalStop;
					} else {
						Reflect.deleteProperty(pathWithStop, "stop");
					}
				}
			}
			if (collectActivity && overlappingTags && overlappingTags.size > 1) {
				onOverlap(passName, initialNode.type, [...overlappingTags].sort());
			}
		};
	};

	const resolved: Visitor = {};
	for (const [key, rawValue] of Object.entries(
		merged as Record<string, unknown>,
	)) {
		if (TRAVERSAL_GLOBAL_VISITOR_OPTION_SET.has(key)) {
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
	options: { telemetryLevel?: AstPassTelemetryLevel } = {},
): Promise<AstPassTelemetry> {
	const telemetryLevel = options.telemetryLevel ?? "deep";
	const collectActivity = telemetryLevel === "deep";
	const collectShapes = telemetryLevel === "deep";
	const passOrder: AstPassName[] = ["discover", "mutate", "finalize"];
	const globallyFailedTags = new Set<string>();
	const unsupportedOptionsByTag = new Map<string, Set<string>>();
	for (const entry of entries) {
		const visitor = entry.pass.visitor as Record<string, unknown>;
		for (const option of TRAVERSAL_GLOBAL_VISITOR_OPTIONS) {
			if (!Object.hasOwn(visitor, option)) continue;
			const unsupported =
				unsupportedOptionsByTag.get(entry.tag) ?? new Set<string>();
			unsupported.add(option);
			unsupportedOptionsByTag.set(entry.tag, unsupported);
		}
	}
	for (const [tag, unsupported] of unsupportedOptionsByTag) {
		globallyFailedTags.add(tag);
		const optionNames = TRAVERSAL_GLOBAL_VISITOR_OPTIONS.filter((option) =>
			unsupported.has(option),
		);
		onPatchError(
			tag,
			new Error(
				optionNames.length === 1
					? `Unsupported traversal-global visitor option: ${optionNames[0]}`
					: `Unsupported traversal-global visitor options: ${optionNames.join(", ")}`,
			),
		);
	}
	const handlerCalls: AstPassTelemetry["handlerCalls"] = {};
	if (collectActivity) {
		for (const { tag } of entries) {
			handlerCalls[tag] ??= { discover: 0, mutate: 0, finalize: 0 };
		}
	}
	const shapeHashers: Record<
		string,
		Record<AstPassName, { before: Hash; after: Hash }>
	> = {};
	if (collectShapes) {
		for (const { tag } of entries) {
			shapeHashers[tag] ??= {
				discover: {
					before: createHash("sha256"),
					after: createHash("sha256"),
				},
				mutate: {
					before: createHash("sha256"),
					after: createHash("sha256"),
				},
				finalize: {
					before: createHash("sha256"),
					after: createHash("sha256"),
				},
			};
		}
	}
	const overlapCounts = new Map<string, AstPassTelemetry["overlaps"][number]>();
	for (const passName of passOrder) {
		const passEntries = entries.filter(
			(entry) =>
				entry.pass.pass === passName && !globallyFailedTags.has(entry.tag),
		);
		if (passEntries.length === 0) continue;
		onPassStart(passName, passEntries.length);
		const merged = mergePassVisitors(passEntries);
		const safeVisitor = materializePassVisitor(
			merged,
			passName,
			onPatchError,
			globallyFailedTags,
			collectActivity,
			collectShapes,
			(tag, pass) => {
				handlerCalls[tag] ??= { discover: 0, mutate: 0, finalize: 0 };
				handlerCalls[tag][pass] += 1;
			},
			(tag, pass, phase, node) => {
				updateShapeHash(shapeHashers[tag][pass][phase], node);
			},
			(pass, nodeType, tags) => {
				const key = `${pass}\0${nodeType}\0${tags.join("\0")}`;
				const existing = overlapCounts.get(key);
				if (existing) {
					existing.count += 1;
				} else {
					overlapCounts.set(key, {
						pass,
						nodeType,
						tags: [...tags],
						count: 1,
					});
				}
			},
		);
		traverse(ast, safeVisitor);
		onPassEnd(passName, passEntries.length);
	}
	const structuralHashes: AstPassTelemetry["structuralHashes"] = {};
	for (const [tag, passHashers] of Object.entries(shapeHashers)) {
		structuralHashes[tag] = {
			discover: {
				beforeSha256: passHashers.discover.before.digest("hex"),
				afterSha256: passHashers.discover.after.digest("hex"),
			},
			mutate: {
				beforeSha256: passHashers.mutate.before.digest("hex"),
				afterSha256: passHashers.mutate.after.digest("hex"),
			},
			finalize: {
				beforeSha256: passHashers.finalize.before.digest("hex"),
				afterSha256: passHashers.finalize.after.digest("hex"),
			},
		};
	}
	return {
		handlerCalls,
		structuralHashes,
		overlaps: [...overlapCounts.values()].sort(
			(left, right) =>
				passOrder.indexOf(left.pass) - passOrder.indexOf(right.pass) ||
				left.nodeType.localeCompare(right.nodeType) ||
				left.tags.join("\0").localeCompare(right.tags.join("\0")),
		),
	};
}
