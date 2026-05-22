export const meta = {
  name: 'patch-update',
  description: 'Validate every patch against a target clean bundle through deep cli.js inspection, check whether watched prompt surfaces are still reachable upstream, and plan fixes',
  whenToUse: 'Use in cc-enhanced when there is a new upstream release to validate against, or when planning a patch update. Goes beyond mise run verify:patches by inspecting each patch against the target clean bundle through direct cli.js reading. Default does anchor-existence checks for prompt surfaces; pass patchedExportPath to also validate needles. Read-only.',
  phases: [
    { title: 'Versioning', detail: 'identify current and target versions, enumerate patches and watched prompt surfaces, filter by args' },
    { title: 'PatchInspection', detail: 'patches in scope inspected in parallel via patch-verifier against the target bundle' },
    { title: 'PromptAnchors', detail: 'watched prompt surfaces checked for upstream reachability against the target bundle; optional needle validation against a patched export' },
    { title: 'FixPlan', detail: 'synthesize a unified plan prioritized by severity' },
  ],
}

const VERSIONING_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary', 'patches', 'promptSurfaces'],
  properties: {
    outcome: { enum: ['ready', 'no-target-bundle', 'blocked'] },
    summary: { type: 'string' },
    currentVersion: { type: 'string' },
    targetVersion: { type: 'string' },
    targetBundlePath: { type: 'string' },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tag', 'sourceFile'],
        properties: {
          tag: { type: 'string' },
          sourceFile: { type: 'string' },
          group: { type: 'string' },
        },
      },
    },
    promptSurfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          extractorAnchors: { type: 'array', items: { type: 'string' } },
          requiredNeedles: { type: 'array', items: { type: 'string' } },
          forbiddenNeedles: { type: 'array', items: { type: 'string' } },
          optional: { type: 'boolean' },
        },
      },
    },
    blockedReason: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const PATCH_INSPECTION_SCHEMA = {
  type: 'object',
  required: ['tag', 'status', 'concerns', 'evidence'],
  properties: {
    tag: { type: 'string' },
    status: { enum: ['OK', 'DRIFT', 'BROKEN', 'UNKNOWN'] },
    anchorsChecked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['anchor', 'hits'],
        properties: {
          anchor: { type: 'string' },
          hits: { type: 'number' },
          lines: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    structuralContext: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    rootCauseHypothesis: { type: 'string' },
    suggestedApproach: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        filesToEdit: { type: 'array', items: { type: 'string' } },
        risk: { enum: ['low', 'medium', 'high'] },
        confidence: { enum: ['high', 'medium', 'low'] },
      },
    },
  },
}

const PROMPT_ANCHOR_SCHEMA = {
  type: 'object',
  required: ['surface', 'status', 'evidence'],
  properties: {
    surface: { type: 'string' },
    status: { enum: ['anchor-present', 'anchor-drifted', 'anchor-absent', 'optional-absent', 'unknown'] },
    anchorsChecked: {
      type: 'array',
      items: {
        type: 'object',
        required: ['anchor', 'hits'],
        properties: {
          anchor: { type: 'string' },
          hits: { type: 'number' },
          lines: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    needleValidation: {
      type: 'object',
      properties: {
        ran: { type: 'boolean' },
        exportPath: { type: 'string' },
        requiredFound: { type: 'array', items: { type: 'string' } },
        requiredMissing: { type: 'array', items: { type: 'string' } },
        forbiddenFound: { type: 'array', items: { type: 'string' } },
      },
    },
    evidence: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    suggestedFix: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'fixes', 'verification'],
  properties: {
    status: { enum: ['ready-to-ship', 'fixes-needed', 'investigate', 'blocked'] },
    summary: { type: 'string' },
    scope: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        patchesInspected: { type: 'number' },
        patchesSkipped: { type: 'number' },
        promptSurfacesChecked: { type: 'number' },
        needleValidationRan: { type: 'boolean' },
      },
    },
    counts: {
      type: 'object',
      properties: {
        patchesOk: { type: 'number' },
        patchesDrift: { type: 'number' },
        patchesBroken: { type: 'number' },
        patchesUnknown: { type: 'number' },
        surfacesAnchorPresent: { type: 'number' },
        surfacesAnchorDrifted: { type: 'number' },
        surfacesAnchorAbsent: { type: 'number' },
      },
    },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'identifier', 'priority', 'approach'],
        properties: {
          source: { enum: ['patch', 'prompt-surface'] },
          identifier: { type: 'string' },
          priority: { enum: ['critical', 'high', 'medium', 'low'] },
          status: { type: 'string' },
          approach: { type: 'string' },
          filesToEdit: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string' },
          confidence: { type: 'string' },
        },
      },
    },
    verification: { type: 'array', items: { type: 'string' } },
    crossCuttingConcerns: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const argsObj = (() => {
  if (args && typeof args === 'object') return args
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
    return { focus: args.trim() }
  }
  return {}
})()

const mode = argsObj.mode === 'quick' ? 'quick' : 'full'
const groupFilter = typeof argsObj.group === 'string' ? argsObj.group : null
const tagFilter = typeof argsObj.tag === 'string'
  ? argsObj.tag.split(',').map((s) => s.trim()).filter(Boolean)
  : Array.isArray(argsObj.tag) ? argsObj.tag : null
const versionOverride = typeof argsObj.version === 'string' ? argsObj.version : null
const patchedExportPath = typeof argsObj.patchedExportPath === 'string' ? argsObj.patchedExportPath : null
const focus = typeof argsObj.focus === 'string' && argsObj.focus.trim()
  ? `\nUser focus: ${argsObj.focus.trim()}`
  : ''

phase('Versioning')
const versioning = await agent(
  `Discover the cc-enhanced patch and prompt-surface inventory plus the target clean bundle for validation.

Steps:
1. Identify the current promoted version (run \`mise run status\` or read \`claude --version\` output). Set currentVersion.
2. Identify the target version. ${versionOverride ? `The user specified version: ${versionOverride}. Use that as targetVersion.` : 'Use the highest-numbered subdirectory under versions_clean/ that has a cli.js inside.'} Set targetVersion.
3. Set targetBundlePath to versions_clean/<targetVersion>/cli.js. If that file does not exist, set outcome to no-target-bundle and include the exact command the user should run (mise run native:pull -- <targetVersion>) in notes. Stop there.
4. Read src/patches/index.ts to enumerate every patch. For each: tag (e.g. "edit-extended"), sourceFile (e.g. "src/patches/edit-extended.ts"), and group (look up in src/patch-metadata.ts BY_TAG).
5. Read src/verification/prompt-surface-rules.ts to enumerate watched prompt surfaces. For each surface, set path, requiredNeedles, forbiddenNeedles, optional. Also set extractorAnchors: the literal strings the prompt extractor uses to locate this surface in cli.js (look in scripts/export-prompts.ts for the matching extractor). These are the strings whose presence/absence indicates whether the surface still exists upstream.

If everything resolves, set outcome=ready. If fundamental files are missing, set outcome=blocked with blockedReason.

Do not modify any files. Do not run mise run native:update, native:fetch, native:pull, native:promote, or any write-side command. Do not commit or push.${focus}`,
  {
    label: 'versioning + inventory',
    phase: 'Versioning',
    schema: VERSIONING_SCHEMA,
  },
)

if (!versioning || versioning.outcome === 'blocked') {
  return {
    status: 'blocked',
    versioning,
    summary: versioning?.blockedReason ?? 'versioning phase returned null',
  }
}

if (versioning.outcome === 'no-target-bundle') {
  return {
    status: 'no-target-bundle',
    versioning,
    summary: versioning.summary,
  }
}

const allPatches = versioning.patches ?? []
const allSurfaces = versioning.promptSurfaces ?? []
const targetBundle = versioning.targetBundlePath

const filteredPatches = allPatches.filter((p) => {
  if (groupFilter && p.group !== groupFilter) return false
  if (tagFilter && !tagFilter.includes(p.tag)) return false
  return true
})

const patchesInScope = mode === 'quick' && !groupFilter && !tagFilter
  ? filteredPatches.filter((p) => ['Prompt', 'System', 'Tooling'].includes(p.group))
  : filteredPatches

const patchesSkipped = allPatches.length - patchesInScope.length

phase('PatchInspection')
const patchFindings = await parallel(
  patchesInScope.map((p) => () => agent(
    `Deep-inspect the cc-enhanced patch \`${p.tag}\` (source: ${p.sourceFile}) against ${targetBundle}.

This is a proactive validation, not a failure diagnosis. Validate every anchor the patch depends on, even if the patch is currently passing verify:patches.

Methodology:
1. Read ${p.sourceFile} in full. Extract every anchor: string literals, object property names, AST structural patterns, what verify() asserts, what string() replaces if present.
2. For each anchor, search ${targetBundle} with rg -n for hits + line numbers and rg -c for counts. Use bat -r or bun run inspect for structural context when the match could be ambiguous.
3. Compare hit counts and locations to what the patch expects. A patch that searches for 3 occurrences but finds 5 is DRIFT. A patch whose primary anchor returns 0 hits is BROKEN.
4. Classify as OK, DRIFT, BROKEN, or UNKNOWN.
5. If not OK, propose a root cause and a fix approach. Do not write code.

Return anchorsChecked, structuralContext, concerns, evidence (file:line citations from cli.js), rootCauseHypothesis if not OK, and suggestedApproach if a fix is needed.

Do not run the patcher. Do not modify any files.`,
    {
      label: `inspect:${p.tag}`,
      phase: 'PatchInspection',
      schema: PATCH_INSPECTION_SCHEMA,
      agentType: 'patch-verifier',
    },
  )),
)

const confirmedPatchFindings = (patchFindings ?? []).filter(Boolean)

phase('PromptAnchors')
const surfacesInScope = mode === 'quick' ? allSurfaces.slice(0, 5) : allSurfaces

const promptFindings = await parallel(
  surfacesInScope.map((surface) => () => agent(
    `Validate whether the watched prompt surface \`${surface.path}\` is still REACHABLE in the target clean bundle.

This is an anchor-existence check on a CLEAN bundle, not a needle validation. Required and forbidden needles describe POST-patch state and cannot be validated against a clean cli.js. ${patchedExportPath ? `A patched export path was provided (${patchedExportPath}); needle validation against that export is enabled below.` : 'No patched export was provided; needle validation is skipped.'}

Extractor anchors (the literal strings scripts/export-prompts.ts uses to locate this surface): ${JSON.stringify(surface.extractorAnchors ?? [])}
Optional flag: ${surface.optional === true ? 'true (surface may legitimately be filtered out by tools-off / agents-off)' : 'false (surface should exist)'}

Anchor-existence steps:
1. Search ${targetBundle} with rg -n for each extractor anchor. Record anchorsChecked (anchor text, hits, line numbers).
2. Status:
   - anchor-present: every extractor anchor is found with the expected uniqueness.
   - anchor-drifted: anchors found but counts changed or context shifted in a way that may affect extraction.
   - anchor-absent: required extractor anchors are missing; the surface was removed or restructured upstream.
   - optional-absent: anchors absent but the surface is marked optional.
   - unknown: cannot determine from evidence.

${patchedExportPath ? `Optional needle validation (ONLY if anchor-present or anchor-drifted):
3. The file at ${patchedExportPath} should be the patched export's version of this surface (or the export directory containing it). Read it.
4. Required needles (must be present in the patched export): ${JSON.stringify(surface.requiredNeedles ?? [])}
5. Forbidden needles (must not appear in the patched export): ${JSON.stringify(surface.forbiddenNeedles ?? [])}
6. Search the export with rg -n for each needle. Populate needleValidation.ran=true, requiredFound, requiredMissing, forbiddenFound.
7. If any required needle is missing OR any forbidden needle is present, downgrade status from anchor-present to anchor-drifted and add concerns.` : `Set needleValidation.ran=false (no patched export was provided).
For full needle validation against patched output, the user should run \`mise run verify:prompt-surfaces -- <patched-export-dir>\` after promoting the patched binary, or re-run this workflow with patchedExportPath in args.`}

8. If not anchor-present, propose a fix sketch (which patch/extractor/rules-file needs an update). Do not write code.

Return evidence (file:line citations), concerns, and suggestedFix if not anchor-present.

Do not run the patcher. Do not run mise run prompts:export. Do not modify any files.`,
    {
      label: `anchor:${surface.path}`,
      phase: 'PromptAnchors',
      schema: PROMPT_ANCHOR_SCHEMA,
      agentType: 'patch-verifier',
    },
  )),
)

const confirmedPromptFindings = (promptFindings ?? []).filter(Boolean)

phase('FixPlan')
const plan = await agent(
  `Synthesize a unified fix plan from the patch inspections and prompt-anchor checks.

Scope used:
- mode: ${mode}
- groupFilter: ${groupFilter ?? 'none'}
- tagFilter: ${tagFilter ? tagFilter.join(',') : 'none'}
- patches inspected: ${confirmedPatchFindings.length} / ${allPatches.length} (${patchesSkipped} skipped)
- prompt surfaces checked: ${confirmedPromptFindings.length} / ${allSurfaces.length}
- needle validation ran: ${patchedExportPath ? 'true (against ' + patchedExportPath + ')' : 'false'}

Versioning context:
${JSON.stringify({
  currentVersion: versioning.currentVersion,
  targetVersion: versioning.targetVersion,
  targetBundlePath: versioning.targetBundlePath,
})}

Patch findings:
${JSON.stringify(confirmedPatchFindings)}

Prompt-anchor findings:
${JSON.stringify(confirmedPromptFindings)}

Build counts (patchesOk/Drift/Broken/Unknown, surfacesAnchorPresent/Drifted/Absent).

Build a single fixes array combining both sources:
- For each non-OK patch finding: source=patch, identifier=tag.
- For each non-anchor-present prompt finding: source=prompt-surface, identifier=path.

Priority rubric:
- BROKEN patch with concrete root cause: high
- BROKEN patch with no clear root cause: critical
- prompt anchor-absent (not optional): critical
- DRIFT patch hiding a no-op or count regression: medium
- prompt anchor-drifted with concerns: high
- DRIFT patch that is cosmetic only: low
- UNKNOWN classification: critical (needs human classification before shipping)

Order fixes by priority (critical first), then by source (patches first, then prompt surfaces).

crossCuttingConcerns: flag patterns across findings. Examples: "five patches all reference the same anchor that moved in this release" or "two prompt surfaces lost the same extractor anchor (likely a shared upstream rename)".

verification: list exact commands. Always include mise run verify:patches. If needle validation did not run, recommend the user run \`mise run prompts:export -- <targetVersion>\` after promoting and then re-run this workflow with patchedExportPath pointing at the export directory.

Status:
- ready-to-ship: every finding is OK / anchor-present. No fixes needed.
- fixes-needed: there are fixes but each has a concrete approach and confidence is high or medium.
- investigate: any UNKNOWN classification, low-confidence fix, or contradiction.
- blocked: findings could not be produced.

Set scope = {mode, patchesInspected, patchesSkipped, promptSurfacesChecked, needleValidationRan}.

Do not write code, edit files, or commit.${focus}`,
  {
    label: 'unified fix plan',
    phase: 'FixPlan',
    schema: PLAN_SCHEMA,
  },
)

return {
  scope: { mode, groupFilter, tagFilter, patchedExportPath },
  versioning,
  patchFindings: confirmedPatchFindings,
  promptFindings: confirmedPromptFindings,
  plan,
}
