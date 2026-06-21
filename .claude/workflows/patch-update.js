export const meta = {
  name: 'patch-update',
  description: 'Validate every patch against a target clean bundle through deep cli.js inspection, check watched prompt-surface reachability, and plan fixes',
  whenToUse: 'Use in cc-enhanced when there is a new upstream release to validate against, or when planning a patch update. Goes beyond mise run verify:patches by inspecting patches and watched prompt-surface anchors against the target clean bundle through direct cli.js reading. Complex and high-interaction patches get a dedicated agent; small independent patches are grouped to keep fan-out and tokens bounded. Prompt-surface checks use patch-verifier prompt-surface mode; pass patchedExportPath to also validate needles. Read-only.',
  phases: [
    { title: 'Versioning', detail: 'identify current and target versions, enumerate patches and watched prompt surfaces, filter by args' },
    { title: 'PatchInspection', detail: 'patches grouped into work units and inspected in parallel via patch-verifier against the target bundle' },
    { title: 'PromptAnchors', detail: 'watched prompt surfaces checked in batches for upstream reachability against the target bundle; optional needle validation against a patched export' },
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
        required: ['tag', 'sourceFile', 'sourceLines', 'interactionRisk'],
        properties: {
          tag: { type: 'string' },
          sourceFile: { type: 'string' },
          group: { type: 'string' },
          sourceLines: { type: 'number', description: 'line count of the patch source file' },
          interactionRisk: { enum: ['high', 'low'], description: 'high if the patch appears in the CLAUDE.md Pipeline Ordering shared-visitor table or a known rewrite-cascade; low otherwise' },
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
    testCoverageNote: { enum: ['existing', 'missing', 'needs new fixture'] },
    testCoverageEvidence: { type: 'string' },
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

const UNIT_INSPECTION_SCHEMA = {
  type: 'object',
  required: ['inspections'],
  properties: {
    inspections: { type: 'array', items: PATCH_INSPECTION_SCHEMA },
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

const SURFACE_UNIT_SCHEMA = {
  type: 'object',
  required: ['anchors'],
  properties: {
    anchors: { type: 'array', items: PROMPT_ANCHOR_SCHEMA },
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
        patchesNotInspected: { type: 'number' },
        promptSurfacesChecked: { type: 'number' },
        promptSurfacesNotChecked: { type: 'number' },
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
          source: { enum: ['patch', 'prompt-surface', 'not-inspected'] },
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

// Warm the shared prompt-cache on the first unit, then run the rest in small batches so a
// wide fan-out doesn't burst the input-token rate limit. One agent per unit; nulls retry once.
// Returns { results, dropped }: results is index-aligned with items (null where an agent never
// succeeded); dropped lists the items that were still null after the retry, so the caller can
// report them instead of silently losing them.
async function throttledFanout(items, run, { width = 4, warm = true } = {}) {
  const out = new Array(items.length).fill(null)
  const queue = items.map((_, i) => i)
  if (warm && queue.length > 1) {
    const first = queue.shift()
    const r = await run(items[first], first)
    if (r == null) queue.unshift(first) // warm call failed; fold it back into the normal drain
    else out[first] = r
  }
  const drain = async (idxs) => {
    const missed = []
    for (let i = 0; i < idxs.length; i += width) {
      const slice = idxs.slice(i, i + width)
      const got = await parallel(slice.map((idx) => () => run(items[idx], idx)))
      got.forEach((g, k) => {
        if (g == null) missed.push(slice[k])
        else out[slice[k]] = g
      })
    }
    return missed
  }
  let missed = await drain(queue)
  if (missed.length) {
    log(`throttledFanout: ${missed.length} of ${items.length} unit(s) returned null (likely rate-limited); retrying once`)
    missed = await drain(missed)
  }
  const dropped = missed.map((idx) => items[idx])
  if (dropped.length) {
    log(`throttledFanout: ${dropped.length} unit(s) still failed after retry; they will be reported as not-checked`)
  }
  return { results: out, dropped }
}

// Group patches into work units. Complex (large source) or high-interaction patches each get a
// solo unit for deep, isolated inspection; small independent patches are batched so fan-out and
// tokens stay bounded. interactionRisk and sourceLines come from the versioning agent.
const SOLO_LINE_THRESHOLD = 700
const BATCH_SIZE = 5
const SURFACE_BATCH_SIZE = 6

function buildWorkUnits(patches) {
  const solo = []
  const small = []
  for (const p of patches) {
    const big = typeof p.sourceLines === 'number' && p.sourceLines >= SOLO_LINE_THRESHOLD
    const hot = p.interactionRisk === 'high'
    if (big || hot) solo.push(p)
    else small.push(p)
  }
  const units = solo.map((p) => ({ kind: 'solo', patches: [p] }))
  for (let i = 0; i < small.length; i += BATCH_SIZE) {
    units.push({ kind: 'batch', patches: small.slice(i, i + BATCH_SIZE) })
  }
  return units
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// Trim a full inspection / anchor result down to what the synthesizer needs to reason about
// priority. Full anchor-hit detail is carried in the workflow return value, so re-feeding it to
// the FixPlan agent would just balloon tokens.
function compactInspection(i) {
  return {
    tag: i.tag,
    status: i.status,
    concerns: i.concerns ?? [],
    keyEvidence: (i.evidence ?? []).slice(0, 2),
    testCoverageNote: i.testCoverageNote ?? null,
    rootCauseHypothesis: i.rootCauseHypothesis ?? null,
    suggestedApproach: i.suggestedApproach ?? null,
  }
}

function compactAnchor(a) {
  return {
    surface: a.surface,
    status: a.status,
    concerns: a.concerns ?? [],
    needleValidationRan: a.needleValidation?.ran ?? false,
    requiredMissing: a.needleValidation?.requiredMissing ?? [],
    forbiddenFound: a.needleValidation?.forbiddenFound ?? [],
    keyEvidence: (a.evidence ?? []).slice(0, 2),
    suggestedFix: a.suggestedFix ?? null,
  }
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
5. For every patch set sourceLines: run a single command like \`wc -l src/patches/*.ts\` (or rg -c '.' per file) and record the line count of each patch source. This drives whether a patch is inspected solo or batched, so populate it for all patches.
6. For every patch set interactionRisk: read the "Pipeline Ordering" section of CLAUDE.md (the shared-visitor-kinds table and the known rewrite-cascade note). Mark interactionRisk=high for any patch named in that table or in a rewrite-cascade interaction; mark interactionRisk=low otherwise.
7. Read src/verification/prompt-surface-rules.ts to enumerate watched prompt surfaces. For each surface, set path, requiredNeedles, forbiddenNeedles, optional. Also set extractorAnchors: the literal strings the prompt extractor uses to locate this surface in cli.js (look in scripts/export-prompts.ts for the matching extractor). These are the strings whose presence/absence indicates whether the surface still exists upstream.

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

if (!versioning.targetBundlePath) {
  return {
    status: 'blocked',
    versioning,
    summary: 'versioning reported ready but did not provide a targetBundlePath; cannot inspect against an undefined bundle.',
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

if (patchesInScope.length === 0) {
  return {
    status: 'blocked',
    versioning,
    summary: `No patches matched the requested scope (group=${groupFilter ?? 'none'}, tag=${tagFilter ? tagFilter.join(',') : 'none'}). Nothing to inspect.`,
  }
}

phase('PatchInspection')
const units = buildWorkUnits(patchesInScope)
log(`PatchInspection: ${patchesInScope.length} patch(es) in ${units.length} work unit(s) (${units.filter((u) => u.kind === 'solo').length} solo, ${units.filter((u) => u.kind === 'batch').length} batched)`)

const runInspectUnit = (unit) => {
  const list = unit.patches
    .map((p) => `- \`${p.tag}\` (source: ${p.sourceFile}${p.group ? `, group: ${p.group}` : ''})`)
    .join('\n')
  const deepNote = unit.kind === 'solo'
    ? 'This patch is large or high-interaction. Inspect it deeply. If it appears in the CLAUDE.md Pipeline Ordering shared-visitor table, explicitly reason about how its mutation could interact with sibling patches registering visitors for the same AST node kind, and whether its anchor could be neutralized by another patch (rewrite-cascade).'
    : 'These are smaller, lower-interaction patches grouped for efficiency. Inspect each one fully and independently, and return exactly one entry per patch in inspections[], in the order listed.'
  return agent(
    `Deep-inspect the following cc-enhanced patch(es) against ${targetBundle}.

Patches in this unit:
${list}

${deepNote}

This is a proactive validation, not a failure diagnosis. Validate every anchor each patch depends on, even if the patch is currently passing verify:patches.

${targetBundle} is a CLEAN, pre-patch bundle: only the OLD/search anchors a patch matches on are expected to be present. Any text that verify() or string() injects, and any post-mutation invariant, is by definition absent from a clean bundle, so its absence is NOT evidence the patch is BROKEN. Judge BROKEN/DRIFT on whether the search anchors the patch keys on still exist and remain unambiguous, not on the absence of post-patch output.

For EACH patch:
1. Read the patch source file in full. Extract every anchor: string literals, object property names, AST structural patterns, what verify() asserts, what string() replaces if present.
2. Read the matching test file when present: src/patches/<tag>.test.ts.
3. For each anchor, search ${targetBundle} with rg -n for hits + line numbers and rg -c for counts. This rg use is the cc-enhanced cli.js exception for minified bundle anchor text; do not generalize it to ordinary source-code search. Use bat -r or bun run inspect for structural context when the match could be ambiguous.
4. Compare hit counts and locations to what the patch expects. A patch that searches for 3 occurrences but finds 5 is DRIFT. A patch whose primary anchor returns 0 hits is BROKEN.
5. Classify as OK, DRIFT, BROKEN, or UNKNOWN.
6. Set testCoverageNote (existing | missing | needs new fixture) and put file:line evidence or the gap in testCoverageEvidence.
7. If not OK, propose a rootCauseHypothesis and a suggestedApproach (summary, filesToEdit, risk, confidence). Do not write code.

Return inspections: one object per patch with tag, status, anchorsChecked, structuralContext, concerns, evidence (file:line citations from cli.js), testCoverageNote, testCoverageEvidence, rootCauseHypothesis if not OK, and suggestedApproach if a fix is needed.

Do not run the patcher. Do not modify any files.`,
    {
      label: unit.kind === 'solo'
        ? `inspect:${unit.patches[0].tag}`
        : `inspect-batch:${unit.patches.map((p) => p.tag).join('+')}`,
      phase: 'PatchInspection',
      schema: UNIT_INSPECTION_SCHEMA,
      agentType: 'patch-verifier',
    },
  )
}

const { results: patchUnitResults, dropped: droppedPatchUnits } = await throttledFanout(units, runInspectUnit)
const confirmedPatchFindings = patchUnitResults
  .filter(Boolean)
  .flatMap((r) => r.inspections ?? [])
  .filter(Boolean)
const notInspectedTags = droppedPatchUnits.flatMap((u) => u.patches.map((p) => p.tag))

phase('PromptAnchors')
const surfacesInScope = mode === 'quick' ? allSurfaces.slice(0, 5) : allSurfaces
const surfaceUnits = chunk(surfacesInScope, SURFACE_BATCH_SIZE)

const runSurfaceUnit = (surfaces) => {
  const blocks = surfaces
    .map((s, n) => `Surface ${n + 1}: \`${s.path}\`
  extractorAnchors: ${JSON.stringify(s.extractorAnchors ?? [])}
  optional: ${s.optional === true ? 'true (may legitimately be filtered out by tools-off / agents-off)' : 'false (surface should exist)'}${patchedExportPath ? `
  requiredNeedles: ${JSON.stringify(s.requiredNeedles ?? [])}
  forbiddenNeedles: ${JSON.stringify(s.forbiddenNeedles ?? [])}` : ''}`)
    .join('\n\n')
  return agent(
    `Use prompt-surface mode. For EACH watched prompt surface below, validate whether it is still REACHABLE in the target clean bundle. Return exactly one entry per surface in anchors[], in the order listed.

This is an anchor-existence check on a CLEAN bundle. Required and forbidden needles describe POST-patch state and cannot be validated against a clean cli.js. ${patchedExportPath ? `A patched export path was provided (${patchedExportPath}); needle validation against that export is enabled below.` : 'No patched export was provided; needle validation is skipped (set needleValidation.ran=false).'}

Surfaces in this unit:
${blocks}

For EACH surface:
1. Search ${targetBundle} with rg -n for each extractor anchor. This is the cc-enhanced cli.js exception for minified bundle anchor text, not general source-code routing. Record anchorsChecked (anchor text, hits, line numbers).
2. Status:
   - anchor-present: every extractor anchor is found with the expected uniqueness.
   - anchor-drifted: anchors found but counts changed or context shifted in a way that may affect extraction.
   - anchor-absent: required extractor anchors are missing; the surface was removed or restructured upstream.
   - optional-absent: anchors absent but the surface is marked optional.
   - unknown: cannot determine from evidence.
${patchedExportPath ? `3. Needle validation (ONLY if anchor-present or anchor-drifted): the path ${patchedExportPath} is the patched export (or the directory containing it). Read the relevant exported file for this surface, search it with rg -n for each required and forbidden needle, and populate needleValidation.ran=true, requiredFound, requiredMissing, forbiddenFound. If any required needle is missing OR any forbidden needle is present, downgrade status from anchor-present to anchor-drifted and add concerns.` : `3. Set needleValidation.ran=false (no patched export was provided). For full needle validation, the user should run \`mise run verify:prompt-surfaces -- <patched-export-dir>\` after promoting, or re-run this workflow with patchedExportPath in args.`}
4. If not anchor-present, propose a fix sketch (which patch/extractor/rules-file needs an update). Do not write code.

Return evidence (file:line citations), concerns, and suggestedFix per surface if not anchor-present.

Do not run the patcher. Do not run mise run prompts:export. Do not modify any files.`,
    {
      label: `anchors:${surfaces.length}x`,
      phase: 'PromptAnchors',
      schema: SURFACE_UNIT_SCHEMA,
      agentType: 'patch-verifier',
    },
  )
}

const { results: surfaceUnitResults, dropped: droppedSurfaceUnits } = surfaceUnits.length > 0
  ? await throttledFanout(surfaceUnits, runSurfaceUnit)
  : { results: [], dropped: [] }
const confirmedPromptFindings = surfaceUnitResults
  .filter(Boolean)
  .flatMap((r) => r.anchors ?? [])
  .filter(Boolean)
const notCheckedSurfaces = droppedSurfaceUnits.flatMap((u) => u.map((s) => s.path))

phase('FixPlan')
const plan = await agent(
  `Synthesize a unified fix plan from the patch inspections and prompt-anchor checks.

Scope used:
- mode: ${mode}
- groupFilter: ${groupFilter ?? 'none'}
- tagFilter: ${tagFilter ? tagFilter.join(',') : 'none'}
- patches inspected: ${confirmedPatchFindings.length} / ${allPatches.length} (${patchesSkipped} out of scope)
- patches NOT inspected after retry (treat as UNKNOWN): ${notInspectedTags.length ? notInspectedTags.join(', ') : 'none'}
- prompt surfaces checked: ${confirmedPromptFindings.length} / ${allSurfaces.length}
- prompt surfaces NOT checked after retry: ${notCheckedSurfaces.length ? notCheckedSurfaces.join(', ') : 'none'}
- needle validation ran: ${patchedExportPath ? `true (against ${patchedExportPath})` : 'false'}

Versioning context:
${JSON.stringify({
  currentVersion: versioning.currentVersion,
  targetVersion: versioning.targetVersion,
  targetBundlePath: versioning.targetBundlePath,
})}

Patch findings (compact projection; full anchor detail is retained out of band):
${JSON.stringify(confirmedPatchFindings.map(compactInspection))}

Prompt-anchor findings (compact projection):
${JSON.stringify(confirmedPromptFindings.map(compactAnchor))}

Build counts (patchesOk/Drift/Broken/Unknown, surfacesAnchorPresent/Drifted/Absent).

Build a single fixes array combining sources:
- For each non-OK patch finding: source=patch, identifier=tag.
- For each non-anchor-present prompt finding: source=prompt-surface, identifier=path.
- For each patch in "patches NOT inspected after retry" and each surface in "prompt surfaces NOT checked": source=not-inspected, identifier=tag/path, priority=high, approach="re-run this workflow (optionally with a narrower tag filter); it could not be inspected this run".

Priority rubric:
- BROKEN patch with concrete root cause: high
- BROKEN patch with no clear root cause: critical
- prompt anchor-absent (not optional): critical
- DRIFT patch hiding a no-op or count regression: medium
- prompt anchor-drifted with concerns: high
- DRIFT patch that is cosmetic only: low
- UNKNOWN classification: critical (needs human classification before shipping)

Order fixes by priority (critical first), then by source (patches first, then prompt surfaces, then not-inspected).

crossCuttingConcerns: flag patterns across findings. Examples: "five patches all reference the same anchor that moved in this release" or "two prompt surfaces lost the same extractor anchor (likely a shared upstream rename)".

verification: list exact commands. Always include mise run verify:patches. If needle validation did not run, recommend the user run \`mise run prompts:export -- <targetVersion>\` after promoting and then re-run this workflow with patchedExportPath pointing at the export directory.

Status:
- ready-to-ship: every finding is OK / anchor-present and nothing was left not-inspected. No fixes needed.
- fixes-needed: there are fixes but each has a concrete approach and confidence is high or medium.
- investigate: any UNKNOWN classification, not-inspected unit, low-confidence fix, or contradiction.
- blocked: findings could not be produced.

Set scope = {mode, patchesInspected, patchesSkipped, patchesNotInspected, promptSurfacesChecked, promptSurfacesNotChecked, needleValidationRan}.

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
  notInspectedTags,
  promptFindings: confirmedPromptFindings,
  notCheckedSurfaces,
  plan,
}
