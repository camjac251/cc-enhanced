import * as t from "@babel/types";
import { type NodePath, template, traverse, type Visitor } from "../babel.js";
import type { Patch } from "../types.js";
import { getObjectKeyName, getVerifyAst } from "./ast-helpers.js";

const TARGET_METADATA_MODEL_KEYS = new Set([
	"claude-fable-5",
	"claude-mythos-5",
	"claude-sonnet-5",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
]);
const TARGET_PIXELS = 2576;
const MANY_IMAGE_COUNT_LIMIT = 20;
const MANY_IMAGE_DIMENSION_LIMIT = 2000;
const MANY_IMAGE_COLLECTOR_NAME = "__ccEnhancedCollectManyImageBlock";
const MANY_IMAGE_DOWNSCALE_HELPER_NAME =
	"__ccEnhancedDownscaleManyImageMessages";
const MANY_IMAGE_RESULT_HELPER_NAME =
	"__ccEnhancedDownscaleNormalizationResult";
const HEADER_BASE64_SAMPLE_CHARS = 87400;

interface ImageLimitEntry {
	key: string;
	maxWidth: t.ObjectProperty;
	maxHeight: t.ObjectProperty;
}

function getObjectProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	for (const prop of objectExpr.properties) {
		if (!t.isObjectProperty(prop)) continue;
		if (getObjectKeyName(prop.key) !== keyName) continue;
		return prop;
	}
	return null;
}

function getNumericProp(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.ObjectProperty | null {
	const prop = getObjectProp(objectExpr, keyName);
	if (!prop || !t.isNumericLiteral(prop.value)) return null;
	return prop;
}

function getNumericLimitEntry(
	objectExpr: t.ObjectExpression,
	key: string,
): ImageLimitEntry | null {
	const maxWidth = getNumericProp(objectExpr, "maxWidth");
	const maxHeight = getNumericProp(objectExpr, "maxHeight");
	if (!maxWidth || !maxHeight) return null;
	return { key, maxWidth, maxHeight };
}

function getModelMetadataImageLimitEntry(
	objectExpr: t.ObjectExpression,
): ImageLimitEntry | null {
	const idProp = getObjectProp(objectExpr, "id");
	if (!idProp || !t.isStringLiteral(idProp.value)) return null;
	const key = idProp.value.value;
	if (!TARGET_METADATA_MODEL_KEYS.has(key)) return null;
	const imageLimitsProp = getObjectProp(objectExpr, "image_limits");
	if (!imageLimitsProp || !t.isObjectExpression(imageLimitsProp.value)) {
		return null;
	}
	return getNumericLimitEntry(imageLimitsProp.value, key);
}

function setEntryPixels(entry: ImageLimitEntry): void {
	entry.maxWidth.value = t.numericLiteral(TARGET_PIXELS);
	entry.maxHeight.value = t.numericLiteral(TARGET_PIXELS);
}

function findParentFunction(
	path: NodePath<t.Node>,
): NodePath<t.Function> | null {
	const functionPath = path.findParent((parent) => parent.isFunction());
	if (!functionPath || !t.isFunction(functionPath.node)) return null;
	return functionPath as NodePath<t.Function>;
}

function getIdentifierParam(
	path: NodePath<t.Function>,
	index: number,
): string | null {
	const param = path.node.params[index];
	if (t.isIdentifier(param)) return param.name;
	if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
		return param.left.name;
	}
	return null;
}

function getFunctionDeclarationName(path: NodePath<t.Function>): string | null {
	if (!t.isFunctionDeclaration(path.node) || !path.node.id) return null;
	return path.node.id.name;
}

function createImageLimitsDiscoverer(state: {
	dimensionReaderName: string | null;
	imageBlockNormalizerName: string | null;
	imageLimitsResolverName: string | null;
}): Visitor {
	return {
		FunctionDeclaration(path) {
			const name = getFunctionDeclarationName(path);
			if (!name) return;
			if (!state.imageBlockNormalizerName && isImageBlockNormalizer(path)) {
				state.imageBlockNormalizerName = name;
			}
			if (!state.imageLimitsResolverName && isImageLimitsResolver(path)) {
				state.imageLimitsResolverName = name;
			}
		},

		StringLiteral(path) {
			if (state.dimensionReaderName) return;
			if (path.node.value !== "VP8X") return;
			const functionPath = findParentFunction(path);
			if (!functionPath) return;
			state.dimensionReaderName = getFunctionDeclarationName(functionPath);
		},

		Program: {
			exit() {
				if (!state.dimensionReaderName) {
					console.warn(
						"image-limits: Could not find image header dimension reader",
					);
				}
				if (!state.imageBlockNormalizerName) {
					console.warn("image-limits: Could not find image block normalizer");
				}
				if (!state.imageLimitsResolverName) {
					console.warn("image-limits: Could not find image limits resolver");
				}
			},
		},
	};
}

function isImageBlockNormalizer(path: NodePath<t.Function>): boolean {
	if (!t.isFunctionDeclaration(path.node) || !path.node.async) return false;
	const imageParam = getIdentifierParam(path, 0);
	const limitsParam = getIdentifierParam(path, 1);
	if (!imageParam || !limitsParam) return false;

	let base64GuardSeen = false;
	let blockReturnSeen = false;
	let normalizeCallSeen = false;

	path.traverse({
		StringLiteral(innerPath) {
			if (innerPath.node.value === "base64") base64GuardSeen = true;
		},

		ReturnStatement(innerPath) {
			const arg = innerPath.node.argument;
			if (!t.isObjectExpression(arg)) return;
			const blockProp = getObjectProp(arg, "block");
			if (blockProp && t.isIdentifier(blockProp.value, { name: imageParam })) {
				blockReturnSeen = true;
			}
		},

		CallExpression(innerPath) {
			const [arg] = innerPath.node.arguments;
			if (!t.isObjectExpression(arg)) return;
			const dataProp = getObjectProp(arg, "data");
			const mediaTypeProp = getObjectProp(arg, "mediaType");
			const limitsProp = getObjectProp(arg, "limits");
			if (!dataProp || !mediaTypeProp || !limitsProp) return;
			if (!t.isIdentifier(limitsProp.value, { name: limitsParam })) return;
			normalizeCallSeen = true;
		},
	});

	return base64GuardSeen && blockReturnSeen && normalizeCallSeen;
}

function isImageLimitsResolver(path: NodePath<t.Function>): boolean {
	if (!t.isFunctionDeclaration(path.node)) return false;
	let returnObjectSeen = false;

	path.traverse({
		ReturnStatement(innerPath) {
			const arg = innerPath.node.argument;
			if (!t.isObjectExpression(arg)) return;
			if (
				getObjectProp(arg, "maxWidth") &&
				getObjectProp(arg, "maxHeight") &&
				getObjectProp(arg, "maxBase64Size")
			) {
				returnObjectSeen = true;
			}
		},
	});

	return returnObjectSeen;
}

function buildManyImageDownscaleHelperStatements(
	imageBlockNormalizerName: string,
	dimensionReaderName: string,
): t.Statement[] {
	const buildStmts = template.statements(
		`
		async function ${MANY_IMAGE_DOWNSCALE_HELPER_NAME}(messages, limits) {
			let __ccEnhancedImageBlocks = [];
			let __ccEnhancedVisualBlockCount = 0;
			let ${MANY_IMAGE_COLLECTOR_NAME} = (block) => {
				if (!block || typeof block !== "object") return;
				if (block.type === "image") __ccEnhancedImageBlocks.push(block);
				if (block.type === "image" || block.type === "document")
					__ccEnhancedVisualBlockCount++;
			};
			for (let __ccEnhancedMessage of messages) {
				let __ccEnhancedContent = __ccEnhancedMessage?.message?.content;
				if (!Array.isArray(__ccEnhancedContent)) continue;
				for (let __ccEnhancedBlock of __ccEnhancedContent) {
					${MANY_IMAGE_COLLECTOR_NAME}(__ccEnhancedBlock);
					if (
						__ccEnhancedBlock &&
						typeof __ccEnhancedBlock === "object" &&
						__ccEnhancedBlock.type === "tool_result" &&
						Array.isArray(__ccEnhancedBlock.content)
					) {
						for (let __ccEnhancedNestedBlock of __ccEnhancedBlock.content) {
							${MANY_IMAGE_COLLECTOR_NAME}(__ccEnhancedNestedBlock);
						}
					}
				}
			}
			if (__ccEnhancedVisualBlockCount <= ${MANY_IMAGE_COUNT_LIMIT}) return messages;
			let __ccEnhancedImageTooLargeForManyImage = (block) => {
				let dimensions = block.dimensions;
				if (
					dimensions &&
					(dimensions.displayWidth > ${MANY_IMAGE_DIMENSION_LIMIT} ||
						dimensions.displayHeight > ${MANY_IMAGE_DIMENSION_LIMIT} ||
						dimensions.originalWidth > ${MANY_IMAGE_DIMENSION_LIMIT} ||
						dimensions.originalHeight > ${MANY_IMAGE_DIMENSION_LIMIT})
				)
					return true;
				let source = block.source;
				if (
					!source ||
					typeof source !== "object" ||
					source.type !== "base64" ||
					typeof source.data !== "string"
				)
					return false;
				try {
					let parsed = READ_DIMENSIONS(Buffer.from(source.data.slice(0, ${HEADER_BASE64_SAMPLE_CHARS}), "base64"));
					return (
						parsed !== void 0 &&
						(parsed.width > ${MANY_IMAGE_DIMENSION_LIMIT} ||
							parsed.height > ${MANY_IMAGE_DIMENSION_LIMIT})
					);
				} catch {
					return false;
				}
			};
			if (!__ccEnhancedImageBlocks.some(__ccEnhancedImageTooLargeForManyImage)) return messages;
			let __ccEnhancedDownscaleImageBlock = async (block) => {
				if (!__ccEnhancedImageTooLargeForManyImage(block)) return block;
				let source = block.source;
				if (
					!source ||
					typeof source !== "object" ||
					source.type !== "base64" ||
					typeof source.data !== "string"
				)
					return block;
				try {
					let normalized = await NORMALIZE_IMAGE_BLOCK(block, limits);
					return normalized?.block ?? block;
				} catch {
					return block;
				}
			};
			let __ccEnhancedRewriteContent = async (content) => {
				if (!Array.isArray(content)) return { content, changed: false };
				let changed = false;
				let nextContent = [];
				for (let block of content) {
					if (block?.type === "image") {
						let nextBlock = await __ccEnhancedDownscaleImageBlock(block);
						if (nextBlock !== block) changed = true;
						nextContent.push(nextBlock);
						continue;
					}
					if (
						block &&
						typeof block === "object" &&
						block.type === "tool_result" &&
						Array.isArray(block.content)
					) {
						let rewritten = await __ccEnhancedRewriteContent(block.content);
						if (rewritten.changed) {
							changed = true;
							nextContent.push({ ...block, content: rewritten.content });
						} else nextContent.push(block);
						continue;
					}
					nextContent.push(block);
				}
				return { content: changed ? nextContent : content, changed };
			};
			let changed = false;
			let nextMessages = [];
			for (let message of messages) {
				let rewritten = await __ccEnhancedRewriteContent(message?.message?.content);
				if (rewritten.changed) {
					changed = true;
					nextMessages.push({
						...message,
						message: { ...message.message, content: rewritten.content },
					});
				} else nextMessages.push(message);
			}
			return changed ? nextMessages : messages;
		}
	`,
		{
			placeholderPattern: /^(READ_DIMENSIONS|NORMALIZE_IMAGE_BLOCK)$/,
		},
	);
	return buildStmts({
		READ_DIMENSIONS: t.identifier(dimensionReaderName),
		NORMALIZE_IMAGE_BLOCK: t.identifier(imageBlockNormalizerName),
	});
}

interface NormalizationTargets {
	calls: NodePath<t.CallExpression>[];
	model: t.Expression;
}

function measuredNormalization(
	node: t.Node | null | undefined,
): t.CallExpression | null {
	if (!t.isCallExpression(node)) return null;
	const callback = node.arguments[0];
	return t.isArrowFunctionExpression(callback) &&
		callback.params.length === 0 &&
		t.isCallExpression(callback.body) &&
		t.isIdentifier(callback.body.callee) &&
		callback.body.arguments.length === 2
		? callback.body
		: null;
}

function findNormalizationTargets(
	path: NodePath<t.Function>,
): NormalizationTargets | null {
	let normalizer: string | null = null;
	let model: t.Expression | null = null;
	path.traverse({
		Function(inner) {
			inner.skip();
		},
		VariableDeclarator(inner) {
			if (normalizer || !t.isObjectPattern(inner.node.id)) return;
			const pattern = inner.node.id;
			if (
				!["messagesForAPI", "midConvFallback", "toolChangeFallback"].every(
					(key) =>
						pattern.properties.some(
							(prop) =>
								t.isObjectProperty(prop) && getObjectKeyName(prop.key) === key,
						),
				)
			)
				return;
			let value = inner.node.init;
			if (t.isAwaitExpression(value)) value = value.argument;
			if (
				t.isCallExpression(value) &&
				t.isIdentifier(value.callee, { name: MANY_IMAGE_RESULT_HELPER_NAME })
			) {
				const original = value.arguments[0];
				if (!t.isExpression(original)) return;
				value = original;
			}
			const call = measuredNormalization(value);
			if (!call || !t.isIdentifier(call.callee)) return;
			const options = call.arguments[1];
			if (!t.isIdentifier(options)) return;
			const binding = inner.scope.getBinding(options.name);
			if (
				!binding?.path.isVariableDeclarator() ||
				!t.isObjectExpression(binding.path.node.init)
			)
				return;
			const property =
				getObjectProp(binding.path.node.init, "model") ??
				getObjectProp(binding.path.node.init, "bodyModel");
			if (!property || !t.isExpression(property.value)) return;
			normalizer = call.callee.name;
			model = property.value;
		},
	});
	if (!normalizer || !model) return null;
	const name: string = normalizer;
	const binding = path.scope.getBinding(name);
	const calls: NodePath<t.CallExpression>[] = [];
	path.traverse({
		Function(inner) {
			inner.skip();
		},
		CallExpression(inner) {
			const call = measuredNormalization(inner.node);
			if (
				call &&
				t.isIdentifier(call.callee, { name }) &&
				inner.scope.getBinding(name) === binding
			)
				calls.push(inner);
		},
	});
	return calls.length ? { calls, model } : null;
}

function buildNormalizationResultHelper(
	imageLimitsResolverName: string,
): t.Statement[] {
	// Fallback callers are synchronous; prepare both rebuilt arrays before
	// handing the result back to the request pipeline, including prefix retries.
	return template.statements(
		`
		async function ${MANY_IMAGE_RESULT_HELPER_NAME}(result, model) {
			const limits = { ...IMAGE_LIMITS(model), maxWidth: ${MANY_IMAGE_DIMENSION_LIMIT}, maxHeight: ${MANY_IMAGE_DIMENSION_LIMIT} };
			const normalized = { ...result, messagesForAPI: await ${MANY_IMAGE_DOWNSCALE_HELPER_NAME}(result.messagesForAPI, limits) };
			for (const key of ["midConvFallback", "toolChangeFallback"]) {
				if (result[key]) {
					const messages = await ${MANY_IMAGE_DOWNSCALE_HELPER_NAME}(result[key](), limits);
					normalized[key] = () => messages;
				}
			}
			return normalized;
		}
	`,
		{ placeholderPattern: /^IMAGE_LIMITS$/ },
	)({ IMAGE_LIMITS: t.identifier(imageLimitsResolverName) });
}

type ImageDownscaleState = {
	dimensionReaderName: string | null;
	imageBlockNormalizerName: string | null;
	imageLimitsResolverName: string | null;
};

function functionHasManyImageDownscale(
	path: NodePath<t.Function>,
	state: ImageDownscaleState,
): boolean {
	if (
		!state.dimensionReaderName ||
		!state.imageBlockNormalizerName ||
		!state.imageLimitsResolverName ||
		!t.isBlockStatement(path.node.body)
	)
		return false;
	const targets = findNormalizationTargets(path);
	if (!targets) return false;
	const body = path.node.body;
	const expected = [
		...buildManyImageDownscaleHelperStatements(
			state.imageBlockNormalizerName,
			state.dimensionReaderName,
		),
		...buildNormalizationResultHelper(state.imageLimitsResolverName),
	];
	if (
		!expected.every(
			(statement) =>
				body.body.filter((candidate) =>
					t.isNodesEquivalent(candidate, statement),
				).length === 1,
		)
	)
		return false;
	return targets.calls.every((call) => {
		const wrapper = call.parentPath;
		return (
			wrapper.isCallExpression() &&
			t.isIdentifier(wrapper.node.callee, {
				name: MANY_IMAGE_RESULT_HELPER_NAME,
			}) &&
			wrapper.node.arguments.length === 2 &&
			wrapper.node.arguments[0] === call.node &&
			t.isNodesEquivalent(wrapper.node.arguments[1], targets.model) &&
			wrapper.parentPath.isAwaitExpression()
		);
	});
}

function patchRequestDownscale(
	path: NodePath<t.Function>,
	state: ImageDownscaleState,
): boolean {
	if (
		!path.node.async ||
		!state.dimensionReaderName ||
		!state.imageBlockNormalizerName ||
		!state.imageLimitsResolverName ||
		!t.isBlockStatement(path.node.body)
	)
		return false;
	if (functionHasManyImageDownscale(path, state)) return true;
	const targets = findNormalizationTargets(path);
	if (!targets) return false;
	// Do not layer a second implementation over incomplete injected helpers.
	if (
		path.node.body.body.some(
			(statement) =>
				t.isFunctionDeclaration(statement) &&
				(statement.id?.name === MANY_IMAGE_DOWNSCALE_HELPER_NAME ||
					statement.id?.name === MANY_IMAGE_RESULT_HELPER_NAME),
		)
	)
		return false;
	for (const call of targets.calls) {
		call.replaceWith(
			t.awaitExpression(
				t.callExpression(t.identifier(MANY_IMAGE_RESULT_HELPER_NAME), [
					t.cloneNode(call.node, true),
					t.cloneNode(targets.model, true),
				]),
			),
		);
	}
	path.node.body.body.unshift(
		...buildManyImageDownscaleHelperStatements(
			state.imageBlockNormalizerName,
			state.dimensionReaderName,
		),
		...buildNormalizationResultHelper(state.imageLimitsResolverName),
	);
	return true;
}

function createImageLimitsMutator(state: {
	dimensionReaderName: string | null;
	imageBlockNormalizerName: string | null;
	imageLimitsResolverName: string | null;
}): Visitor {
	const entriesSeen = new Set<string>();
	let requestDownscalePatched = false;

	function patchObjectExpression(path: NodePath<t.ObjectExpression>): void {
		const metadataEntry = getModelMetadataImageLimitEntry(path.node);
		if (metadataEntry) {
			entriesSeen.add(metadataEntry.key);
			setEntryPixels(metadataEntry);
		}
	}

	return {
		ObjectExpression(path) {
			patchObjectExpression(path);
		},

		StringLiteral(path) {
			if (requestDownscalePatched) return;
			if (path.node.value !== "tengu_api_before_normalize") return;
			const functionPath = findParentFunction(path);
			if (!functionPath) return;
			requestDownscalePatched = patchRequestDownscale(functionPath, state);
		},

		Program: {
			exit() {
				const missingKeys = [...TARGET_METADATA_MODEL_KEYS].filter(
					(key) => !entriesSeen.has(key),
				);
				if (missingKeys.length > 0) {
					console.warn(
						`image-limits: Could not find image-limit entries for: ${missingKeys.join(", ")}`,
					);
				}
				if (!requestDownscalePatched) {
					console.warn(
						"image-limits: Could not patch many-image request downscale guard",
					);
				}
			},
		},
	};
}

export const imageLimits: Patch = {
	tag: "image-limits",

	astPasses: () => {
		const state = {
			dimensionReaderName: null as string | null,
			imageBlockNormalizerName: null as string | null,
			imageLimitsResolverName: null as string | null,
		};
		return [
			{
				pass: "discover",
				visitor: createImageLimitsDiscoverer(state),
			},
			{
				pass: "mutate",
				visitor: createImageLimitsMutator(state),
			},
		];
	},

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) return "Unable to parse AST during verification";

		const state: ImageDownscaleState = {
			dimensionReaderName: null,
			imageBlockNormalizerName: null,
			imageLimitsResolverName: null,
		};
		traverse(verifyAst, createImageLimitsDiscoverer(state));
		let downgradedKey: string | null = null;
		let requestNormalizerSeen = false;
		let requestDownscaleGuarded = false;
		const seenKeys = new Set<string>();

		traverse(verifyAst, {
			ObjectExpression(path) {
				const metadataEntry = getModelMetadataImageLimitEntry(path.node);
				if (!metadataEntry) return;
				seenKeys.add(metadataEntry.key);
				const widthVal = (metadataEntry.maxWidth.value as t.NumericLiteral)
					.value;
				const heightVal = (metadataEntry.maxHeight.value as t.NumericLiteral)
					.value;
				if (widthVal !== TARGET_PIXELS || heightVal !== TARGET_PIXELS) {
					downgradedKey ??= metadataEntry.key;
				}
			},

			StringLiteral(path) {
				if (path.node.value !== "tengu_api_before_normalize") return;
				const functionPath = findParentFunction(path);
				if (!functionPath) return;
				requestNormalizerSeen = true;
				if (functionHasManyImageDownscale(functionPath, state)) {
					requestDownscaleGuarded = true;
				}
			},
		});

		const missingKeys = [...TARGET_METADATA_MODEL_KEYS].filter(
			(key) => !seenKeys.has(key),
		);
		if (missingKeys.length > 0) {
			return `Image override entries missing for: ${missingKeys.join(", ")}`;
		}
		if (downgradedKey) {
			return `Image override for "${downgradedKey}" is not pinned to ${TARGET_PIXELS}px`;
		}
		if (!requestNormalizerSeen) {
			return "API request normalization function not found";
		}
		if (!requestDownscaleGuarded) {
			return "Many-image high-resolution downscale guard missing";
		}
		return true;
	},
};
