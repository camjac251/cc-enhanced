import { runCombinedAstPasses } from "../ast-pass-engine.js";
import { parse, print } from "../loader.js";
import type { Patch } from "../types.js";

export const PATCH_SCENARIO_KINDS = [
	"positive",
	"missing",
	"ambiguous",
	"already-satisfied",
	"decoy",
	"sibling-mutation",
] as const;

export type PatchScenarioKind = (typeof PATCH_SCENARIO_KINDS)[number];
export type PatchScenarioStatus = "pass" | "fail";

export interface PatchScenarioExpectation {
	verifications: Record<string, PatchScenarioStatus>;
	outputIncludes?: string[];
	outputExcludes?: string[];
}

export interface PatchScenarioCase {
	kind: PatchScenarioKind;
	source: string;
	expected: PatchScenarioExpectation;
}

export interface PatchScenarioSuite {
	name: string;
	patchTags: string[];
	scenarios: PatchScenarioCase[];
}

const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_SELECTED_PATCHES_PER_FAMILY = 8;
const MAX_GENERATED_CASES = 24;
const MAX_OUTPUT_EXPECTATIONS_PER_CASE = 8;
const MAX_OUTPUT_EXPECTATION_LENGTH = 120;

function boundedDiagnostic(message: string): string {
	return message.length <= MAX_DIAGNOSTIC_LENGTH
		? message
		: `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

export function validatePatchScenarioSuite(suite: PatchScenarioSuite): void {
	const present = new Set(suite.scenarios.map(({ kind }) => kind));
	const missing = PATCH_SCENARIO_KINDS.filter((kind) => !present.has(kind));
	if (missing.length > 0) {
		throw new Error(
			boundedDiagnostic(
				`Scenario suite ${suite.name} for ${suite.patchTags.join(", ")} is missing ${missing.join(", ")}`,
			),
		);
	}
	if (suite.scenarios.length !== PATCH_SCENARIO_KINDS.length) {
		throw new Error(
			boundedDiagnostic(
				`Scenario suite ${suite.name} must declare each standardized case exactly once`,
			),
		);
	}
	for (const scenario of suite.scenarios) {
		for (const tag of suite.patchTags) {
			if (!scenario.expected.verifications[tag]) {
				throw new Error(
					boundedDiagnostic(
						`Scenario suite ${suite.name} case ${scenario.kind} lacks an expected status for ${tag}`,
					),
				);
			}
		}
		const outputExpectations = [
			...(scenario.expected.outputIncludes ?? []),
			...(scenario.expected.outputExcludes ?? []),
		];
		if (
			outputExpectations.length > MAX_OUTPUT_EXPECTATIONS_PER_CASE ||
			outputExpectations.some(
				(expectation) => expectation.length > MAX_OUTPUT_EXPECTATION_LENGTH,
			)
		) {
			throw new Error(
				boundedDiagnostic(
					`Scenario suite ${suite.name} case ${scenario.kind} exceeds bounded output expectations`,
				),
			);
		}
	}
}

export interface SharedVisitorPairDeclaration {
	patchTags: [string, string];
	order: "order-independent" | "canonical-only";
	reason?: string;
}

export interface SharedVisitorFamilyDeclaration {
	name: string;
	visitorKeys: string[];
	patchTags: string[];
	pairs: SharedVisitorPairDeclaration[];
}

export interface SharedVisitorPairCase {
	family: string;
	patchTags: [string, string];
	order: "canonical" | "reverse";
	orderDependency?: string;
}

export const SHARED_VISITOR_FAMILIES: SharedVisitorFamilyDeclaration[] = [
	{
		name: "conditional skill functions",
		visitorKeys: ["Function", "FunctionDeclaration", "FunctionExpression"],
		patchTags: ["skill-paths-invoke", "skill-activation-notice"],
		pairs: [
			{
				patchTags: ["skill-paths-invoke", "skill-activation-notice"],
				order: "order-independent",
			},
		],
	},
];

export interface IntentionalPatchOrderDependency {
	name: string;
	canonicalPatchTags: [string, string];
	reason: string;
}

export const INTENTIONAL_PATCH_ORDER_DEPENDENCIES: IntentionalPatchOrderDependency[] =
	[
		{
			name: "conditional skill matcher reshape",
			canonicalPatchTags: ["skill-global-paths", "skill-activation-notice"],
			reason:
				"activation recording consumes the matcher after global path expansion reshapes it",
		},
	];

function pairKey(left: string, right: string): string {
	return [left, right].sort().join("\0");
}

async function collectMutateVisitorKeys(patch: Patch): Promise<Set<string>> {
	const ast = parse("const scenarioFixture = true;");
	const passes = (await patch.astPasses?.(ast)) ?? [];
	return new Set(
		passes
			.filter(({ pass }) => pass === "mutate")
			.flatMap(({ visitor }) => Object.keys(visitor ?? {})),
	);
}

export async function generateSharedVisitorPairInventory(
	patches: Patch[],
	families: SharedVisitorFamilyDeclaration[],
): Promise<SharedVisitorPairCase[]> {
	const patchByTag = new Map(patches.map((patch) => [patch.tag, patch]));
	const registrationIndex = new Map(
		patches.map((patch, index) => [patch.tag, index]),
	);
	const inventory: SharedVisitorPairCase[] = [];

	for (const family of families) {
		if (family.patchTags.length > MAX_SELECTED_PATCHES_PER_FAMILY) {
			throw new Error(
				boundedDiagnostic(
					`Shared visitor family ${family.name} selects ${family.patchTags.length} patches; maximum is ${MAX_SELECTED_PATCHES_PER_FAMILY}`,
				),
			);
		}
		const selected = family.patchTags.map((tag) => {
			const patch = patchByTag.get(tag);
			if (!patch) {
				throw new Error(
					boundedDiagnostic(
						`Shared visitor family ${family.name} names unregistered patch ${tag}`,
					),
				);
			}
			return patch;
		});
		for (const patch of selected) {
			const keys = await collectMutateVisitorKeys(patch);
			if (!family.visitorKeys.some((key) => keys.has(key))) {
				throw new Error(
					boundedDiagnostic(
						`Shared visitor family ${family.name} includes ${patch.tag}, which has no selected mutate visitor key`,
					),
				);
			}
		}

		const declarations = new Map<string, SharedVisitorPairDeclaration>();
		for (const declaration of family.pairs) {
			if (
				declaration.order === "canonical-only" &&
				!declaration.reason?.trim()
			) {
				throw new Error(
					boundedDiagnostic(
						`Shared visitor family ${family.name} has an intentional order dependency without a reason: ${declaration.patchTags.join(", ")}`,
					),
				);
			}
			declarations.set(pairKey(...declaration.patchTags), declaration);
		}

		for (let left = 0; left < selected.length; left += 1) {
			for (let right = left + 1; right < selected.length; right += 1) {
				const first = selected[left];
				const second = selected[right];
				const declaration = declarations.get(pairKey(first.tag, second.tag));
				if (!declaration) {
					throw new Error(
						boundedDiagnostic(
							`Shared visitor family ${family.name} lacks an interaction declaration for ${first.tag}, ${second.tag}`,
						),
					);
				}
				const canonical = [first.tag, second.tag].sort(
					(a, b) =>
						(registrationIndex.get(a) ?? -1) - (registrationIndex.get(b) ?? -1),
				) as [string, string];
				inventory.push({
					family: family.name,
					patchTags: canonical,
					order: "canonical",
					orderDependency: declaration.reason,
				});
				if (declaration.order === "order-independent") {
					inventory.push({
						family: family.name,
						patchTags: [canonical[1], canonical[0]],
						order: "reverse",
					});
				}
			}
		}
	}

	if (inventory.length > MAX_GENERATED_CASES) {
		throw new Error(
			`Shared visitor inventory generated ${inventory.length} cases; maximum is ${MAX_GENERATED_CASES}`,
		);
	}
	return inventory;
}

export interface PatchScenarioPairResult {
	verifications: Array<{ tag: string; status: PatchScenarioStatus }>;
	diagnostic: string;
}

interface ExecutedPatchScenarioPair {
	output: string;
	verifications: Array<{ tag: string; result: true | string }>;
}

type PatchScenarioPairInput = {
	name: string;
	source: string;
	patches: [Patch, Patch] | Patch[];
};

async function executePatchScenarioPair(
	input: PatchScenarioPairInput,
): Promise<ExecutedPatchScenarioPair> {
	if (input.patches.length !== 2) {
		throw new Error(
			boundedDiagnostic(
				`Patch scenario ${input.name} requires exactly two patches; received ${input.patches.length}`,
			),
		);
	}
	const ast = parse(input.source);
	const entries = [];
	for (const patch of input.patches) {
		const passes = (await patch.astPasses?.(ast)) ?? [];
		for (const pass of passes) entries.push({ tag: patch.tag, pass });
	}
	await runCombinedAstPasses(
		ast,
		entries,
		() => {},
		() => {},
		(_tag, error) => {
			throw error;
		},
	);
	const output = print(ast);
	const verifications = input.patches.map((patch) => ({
		tag: patch.tag,
		result: patch.verify(output, ast),
	}));
	return { output, verifications };
}

function normalizeVerifications(
	verifications: ExecutedPatchScenarioPair["verifications"],
): PatchScenarioPairResult["verifications"] {
	return verifications.map(({ tag, result }) => ({
		tag,
		status: result === true ? "pass" : "fail",
	}));
}

export async function runPatchScenarioPair(
	input: PatchScenarioPairInput,
): Promise<PatchScenarioPairResult> {
	const executed = await executePatchScenarioPair(input);
	const verifications = normalizeVerifications(executed.verifications);
	const failedTags = verifications
		.filter(({ status }) => status === "fail")
		.map(({ tag }) => tag);
	return {
		verifications,
		diagnostic: boundedDiagnostic(
			failedTags.length === 0
				? `Patch scenario ${input.name} passed for ${input.patches.map(({ tag }) => tag).join(", ")}`
				: `Patch scenario ${input.name}: ${failedTags.join(", ")} failed`,
		),
	};
}

export interface PatchScenarioSuiteResult {
	name: string;
	cases: Array<{
		kind: PatchScenarioKind;
		verifications: PatchScenarioPairResult["verifications"];
	}>;
}

export async function runPatchScenarioSuite(
	suite: PatchScenarioSuite,
	patches: [Patch, Patch] | Patch[],
): Promise<PatchScenarioSuiteResult> {
	validatePatchScenarioSuite(suite);
	const actualTags = patches.map(({ tag }) => tag);
	if (
		actualTags.length !== suite.patchTags.length ||
		actualTags.some((tag, index) => tag !== suite.patchTags[index])
	) {
		throw new Error(
			boundedDiagnostic(
				`Scenario suite ${suite.name} patch order does not match its declared tags`,
			),
		);
	}

	const cases: PatchScenarioSuiteResult["cases"] = [];
	for (const scenario of suite.scenarios) {
		const executed = await executePatchScenarioPair({
			name: `${suite.name} ${scenario.kind}`,
			source: scenario.source,
			patches,
		});
		const verifications = normalizeVerifications(executed.verifications);
		for (const { tag, status } of verifications) {
			const expected = scenario.expected.verifications[tag];
			if (expected !== status) {
				throw new Error(
					boundedDiagnostic(
						`Scenario suite ${suite.name} case ${scenario.kind} expected ${tag} ${expected ?? "undeclared"} but got ${status}`,
					),
				);
			}
		}
		for (const [index, needle] of (
			scenario.expected.outputIncludes ?? []
		).entries()) {
			if (!executed.output.includes(needle)) {
				throw new Error(
					boundedDiagnostic(
						`Scenario suite ${suite.name} case ${scenario.kind} failed required output assertion ${index + 1}`,
					),
				);
			}
		}
		for (const [index, needle] of (
			scenario.expected.outputExcludes ?? []
		).entries()) {
			if (executed.output.includes(needle)) {
				throw new Error(
					boundedDiagnostic(
						`Scenario suite ${suite.name} case ${scenario.kind} failed forbidden output assertion ${index + 1}`,
					),
				);
			}
		}
		cases.push({ kind: scenario.kind, verifications });
	}
	return { name: suite.name, cases };
}
