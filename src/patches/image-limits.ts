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
]);
const TARGET_PIXELS = 2576;
const MANY_IMAGE_COUNT_LIMIT = 20;
const MANY_IMAGE_DIMENSION_LIMIT = 2000;
const MANY_IMAGE_COLLECTOR_NAME = "__ccEnhancedCollectManyImageBlock";
const MANY_IMAGE_DOWNSCALE_HELPER_NAME =
	"__ccEnhancedDownscaleManyImageMessages";
const MANY_IMAGE_FALLBACK_RESULT_NAME = "__ccEnhancedDownscaledMidConvFallback";
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

function getFunctionBlock(path: NodePath<t.Function>): t.BlockStatement | null {
	return t.isBlockStatement(path.node.body) ? path.node.body : null;
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

function functionHasManyImageDownscale(path: NodePath<t.Function>): boolean {
	let helperSeen = false;
	let normalizerCallSeen = false;
	let requestAwaitSeen = false;
	let fallbackDownscaleSeen = false;
	let fallbackWrapSeen = false;
	let collectorSeen = false;
	let base64DecodeSeen = false;
	let countLimitSeen = false;
	let dimensionLimitSeen = false;
	let documentBlockCountSeen = false;
	let normalizerFallbackSeen = false;

	path.traverse({
		FunctionDeclaration(innerPath) {
			if (
				t.isIdentifier(innerPath.node.id, {
					name: MANY_IMAGE_DOWNSCALE_HELPER_NAME,
				})
			) {
				helperSeen = true;
			}
		},

		StringLiteral(innerPath) {
			if (innerPath.node.value === "document") documentBlockCountSeen = true;
		},

		Identifier(innerPath) {
			if (innerPath.node.name === MANY_IMAGE_COLLECTOR_NAME)
				collectorSeen = true;
		},

		NumericLiteral(innerPath) {
			if (innerPath.node.value === MANY_IMAGE_COUNT_LIMIT)
				countLimitSeen = true;
			if (innerPath.node.value === MANY_IMAGE_DIMENSION_LIMIT) {
				dimensionLimitSeen = true;
			}
		},

		CallExpression(innerPath) {
			const { callee } = innerPath.node;
			if (
				t.isMemberExpression(callee) &&
				t.isIdentifier(callee.object, { name: "Buffer" }) &&
				t.isIdentifier(callee.property, { name: "from" }) &&
				innerPath.node.arguments.some(
					(arg) => t.isStringLiteral(arg) && arg.value === "base64",
				)
			) {
				base64DecodeSeen = true;
			}
			if (
				t.isIdentifier(callee) &&
				callee.name !== MANY_IMAGE_DOWNSCALE_HELPER_NAME &&
				innerPath.node.arguments.length >= 2
			) {
				const [blockArg, limitsArg] = innerPath.node.arguments;
				if (
					t.isIdentifier(blockArg, { name: "block" }) &&
					t.isIdentifier(limitsArg, { name: "limits" })
				) {
					normalizerCallSeen = true;
				}
			}
		},

		AwaitExpression(innerPath) {
			const arg = innerPath.node.argument;
			if (
				!t.isCallExpression(arg) ||
				!t.isIdentifier(arg.callee, {
					name: MANY_IMAGE_DOWNSCALE_HELPER_NAME,
				})
			) {
				return;
			}
			const parent = innerPath.parentPath;
			if (
				parent?.isAssignmentExpression() &&
				t.isIdentifier(parent.node.left)
			) {
				requestAwaitSeen = true;
			}
			if (
				parent?.isVariableDeclarator() &&
				t.isIdentifier(parent.node.id, {
					name: MANY_IMAGE_FALLBACK_RESULT_NAME,
				})
			) {
				fallbackDownscaleSeen = true;
			}
		},

		AssignmentExpression(innerPath) {
			const right = innerPath.node.right;
			if (
				innerPath.node.operator === "=" &&
				t.isArrowFunctionExpression(right) &&
				!right.async &&
				t.isIdentifier(right.body, {
					name: MANY_IMAGE_FALLBACK_RESULT_NAME,
				})
			) {
				fallbackWrapSeen = true;
			}
		},

		LogicalExpression(innerPath) {
			if (innerPath.node.operator !== "??") return;
			if (!t.isIdentifier(innerPath.node.right, { name: "block" })) return;
			const left = innerPath.node.left;
			if (
				t.isOptionalMemberExpression(left) &&
				t.isIdentifier(left.property, { name: "block" })
			) {
				normalizerFallbackSeen = true;
			}
		},
	});

	return (
		helperSeen &&
		collectorSeen &&
		base64DecodeSeen &&
		countLimitSeen &&
		dimensionLimitSeen &&
		documentBlockCountSeen &&
		normalizerFallbackSeen &&
		normalizerCallSeen &&
		requestAwaitSeen &&
		fallbackDownscaleSeen &&
		fallbackWrapSeen
	);
}

interface RequestDownscaleTarget {
	declarationIndex: number;
	messagesName: string;
	fallbackName: string;
	modelExpr: t.Expression;
}

function getObjectExpressionPropValue(
	objectExpr: t.ObjectExpression,
	keyName: string,
): t.Expression | null {
	const prop = getObjectProp(objectExpr, keyName);
	if (!prop || !t.isExpression(prop.value)) return null;
	return prop.value;
}

function findRequestDownscaleTarget(
	path: NodePath<t.Function>,
): RequestDownscaleTarget | null {
	const body = getFunctionBlock(path);
	if (!body) return null;

	for (let index = 0; index < body.body.length; index++) {
		const stmt = body.body[index];
		if (!t.isVariableDeclaration(stmt)) continue;
		let messagesForApiAlias: string | null = null;
		let fallbackAlias: string | null = null;
		let modelExpr: t.Expression | null = null;

		for (const decl of stmt.declarations) {
			if (!t.isObjectPattern(decl.id)) continue;
			if (!t.isCallExpression(decl.init)) continue;
			const optionsArg = decl.init.arguments[1];
			if (!t.isObjectExpression(optionsArg)) continue;
			modelExpr =
				getObjectExpressionPropValue(optionsArg, "model") ??
				getObjectExpressionPropValue(optionsArg, "bodyModel");
			if (!modelExpr) continue;

			for (const prop of decl.id.properties) {
				if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.value)) {
					continue;
				}
				const keyName = getObjectKeyName(prop.key);
				if (keyName === "messagesForAPI") {
					messagesForApiAlias = prop.value.name;
				}
				if (keyName === "midConvFallback") {
					fallbackAlias = prop.value.name;
				}
			}
		}

		if (!messagesForApiAlias || !fallbackAlias || !modelExpr) continue;
		let messagesName: string | null = null;
		let fallbackName: string | null = null;
		for (const decl of stmt.declarations) {
			if (
				t.isIdentifier(decl.id) &&
				t.isIdentifier(decl.init, { name: messagesForApiAlias })
			) {
				messagesName = decl.id.name;
			}
			if (
				t.isIdentifier(decl.id) &&
				t.isIdentifier(decl.init, { name: fallbackAlias })
			) {
				fallbackName = decl.id.name;
			}
		}
		if (!messagesName || !fallbackName) continue;
		return {
			declarationIndex: index,
			messagesName,
			fallbackName,
			modelExpr,
		};
	}

	return null;
}

function buildRequestDownscaleStatements(
	messagesName: string,
	fallbackName: string,
	modelExpr: t.Expression,
	imageLimitsResolverName: string,
): t.Statement[] {
	// The fallback rebuild runs in sync callers, so the downscaled fallback is
	// computed eagerly here (async context) and the fallback stays a sync
	// function returning the precomputed array. Call sites never need an await.
	const buildStmts = template.statements(
		`
		let __ccEnhancedManyImageLimits = {
			...IMAGE_LIMITS(MODEL),
			maxWidth: ${MANY_IMAGE_DIMENSION_LIMIT},
			maxHeight: ${MANY_IMAGE_DIMENSION_LIMIT},
		};
		MESSAGES = await ${MANY_IMAGE_DOWNSCALE_HELPER_NAME}(MESSAGES, __ccEnhancedManyImageLimits);
		if (FALLBACK) {
			let ${MANY_IMAGE_FALLBACK_RESULT_NAME} = await ${MANY_IMAGE_DOWNSCALE_HELPER_NAME}(
				FALLBACK(),
				__ccEnhancedManyImageLimits,
			);
			FALLBACK = () => ${MANY_IMAGE_FALLBACK_RESULT_NAME};
		}
	`,
		{
			placeholderPattern: /^(IMAGE_LIMITS|MODEL|MESSAGES|FALLBACK)$/,
		},
	);
	return buildStmts({
		IMAGE_LIMITS: t.identifier(imageLimitsResolverName),
		MODEL: t.cloneNode(modelExpr),
		MESSAGES: t.identifier(messagesName),
		FALLBACK: t.identifier(fallbackName),
	});
}

function patchRequestDownscale(
	path: NodePath<t.Function>,
	state: {
		dimensionReaderName: string | null;
		imageBlockNormalizerName: string | null;
		imageLimitsResolverName: string | null;
	},
): boolean {
	if (
		!path.node.async ||
		!state.dimensionReaderName ||
		!state.imageBlockNormalizerName ||
		!state.imageLimitsResolverName
	) {
		return false;
	}
	if (functionHasManyImageDownscale(path)) return true;
	const body = getFunctionBlock(path);
	if (!body) return false;
	const target = findRequestDownscaleTarget(path);
	if (!target) return false;

	const helperStatements = buildManyImageDownscaleHelperStatements(
		state.imageBlockNormalizerName,
		state.dimensionReaderName,
	);
	const requestStatements = buildRequestDownscaleStatements(
		target.messagesName,
		target.fallbackName,
		target.modelExpr,
		state.imageLimitsResolverName,
	);
	body.body.splice(target.declarationIndex, 0, ...helperStatements);
	body.body.splice(
		target.declarationIndex + helperStatements.length + 1,
		0,
		...requestStatements,
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
				if (functionHasManyImageDownscale(functionPath)) {
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
