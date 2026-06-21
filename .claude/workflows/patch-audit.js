export const meta = {
  name: 'patch-audit',
  description: 'Deep health audit of cc-enhanced patches through cli.js inspection plus verifier robustness, pipeline interaction, and docs cross-check',
  whenToUse: 'Use in cc-enhanced for periodic patch health checks or before a push. Goes beyond mise run verify:patches by inspecting every patch in scope against the current clean bundle, auditing each verify() function for false-positive and missed-bug risk in the same pass, identifying cross-patch interactions in the AST pipeline, and verifying patch counts across docs. Complex and high-interaction patches get a dedicated agent; small independent patches are grouped to keep fan-out and tokens bounded. Accepts mode/group/tag filters via args. Read-only.',
  phases: [
    { title: 'PatchInspection', detail: 'patches grouped into work units (complex/interacting patches solo, small patches batched) and inspected in parallel via patch-verifier: anchors, verify() robustness, and test-hardening in one pass' },
    { title: 'PipelineInteraction', detail: 'cross-patch risks in the AST pipeline (full mode only)' },
    { title: 'DocsAndCounts', detail: 'patch counts verified across docs (standard and full modes)' },
    { title: 'Synthesize', detail: 'severity-grouped audit report with next steps' },
  ],
}

const INVENTORY_SCHEMA = {
  type: 'object',
  required: ['outcome', 'currentVersion', 'cleanBundlePath', 'patches'],
  properties: {
    outcome: { enum: ['ready', 'blocked'] },
    currentVersion: { type: 'string' },
    cleanBundlePath: { type: 'string' },
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
    blockedReason: { type: 'string' },
  },
}

const PATCH_INSPECTION_SCHEMA = {
  type: 'object',
  required: ['tag', 'status', 'concerns', 'verifyVerdict'],
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
          ambiguity: { enum: ['none', 'multiple-matches', 'context-dependent'] },
          fragility: { enum: ['low', 'medium', 'high'] },
        },
      },
    },
    structuralContext: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    robustnessNotes: { type: 'array', items: { type: 'string' } },
    // verify() robustness, produced in the same source read as the anchor inspection
    whatVerifyChecks: { type: 'string' },
    verifyVerdict: { enum: ['robust', 'fragile', 'weak', 'unknown'] },
    falsePositiveRisk: {
      type: 'object',
      properties: {
        rating: { enum: ['low', 'medium', 'high'] },
        scenarios: { type: 'array', items: { type: 'string' } },
      },
    },
    missedBugRisk: {
      type: 'object',
      properties: {
        rating: { enum: ['low', 'medium', 'high'] },
        scenarios: { type: 'array', items: { type: 'string' } },
      },
    },
    suggestedHardening: { type: 'string' },
    testCoverageNote: { enum: ['existing', 'missing', 'needs new fixture'] },
    testCoverageEvidence: { type: 'string' },
    testHardening: {
      type: 'object',
      properties: {
        currentCoverage: { type: 'string' },
        gaps: { type: 'array', items: { type: 'string' } },
        assertions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['rationale', 'code'],
            properties: {
              rationale: { type: 'string' },
              anchor: { type: 'string' },
              code: { type: 'string' },
            },
          },
        },
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

const PIPELINE_INTERACTION_SCHEMA = {
  type: 'object',
  required: ['risks', 'summary'],
  properties: {
    summary: { type: 'string' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'patchesInvolved', 'description', 'severity'],
        properties: {
          kind: { enum: ['shared-node-type', 'overlap-range', 'rewrite-cascade', 'pass-order-coupling', 'other'] },
          patchesInvolved: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'array', items: { type: 'string' } },
          suggestedTest: { type: 'string' },
        },
      },
    },
  },
}

const DOCS_SCHEMA = {
  type: 'object',
  required: ['outcome', 'findings'],
  properties: {
    outcome: { enum: ['consistent', 'inconsistent', 'partial-evidence'] },
    actualPatchCount: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'location', 'description'],
        properties: {
          kind: { enum: ['count-mismatch', 'stale-reference', 'missing-mention', 'inconsistent-claim'] },
          location: { type: 'string' },
          description: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'findings', 'nextSteps'],
  properties: {
    status: { enum: ['healthy', 'issues-found', 'critical', 'blocked'] },
    summary: { type: 'string' },
    scope: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        patchesInspected: { type: 'number' },
        patchesSkipped: { type: 'number' },
        patchesNotInspected: { type: 'number' },
        phasesRun: { type: 'array', items: { type: 'string' } },
      },
    },
    counts: {
      type: 'object',
      properties: {
        patchesOk: { type: 'number' },
        patchesDrift: { type: 'number' },
        patchesBroken: { type: 'number' },
        verifiersRobust: { type: 'number' },
        verifiersFragile: { type: 'number' },
        verifiersWeak: { type: 'number' },
        pipelineRisksHigh: { type: 'number' },
        docsFindings: { type: 'number' },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'severity', 'identifier', 'description'],
        properties: {
          source: { enum: ['patch-inspection', 'verifier-audit', 'pipeline-interaction', 'docs-and-counts', 'not-inspected'] },
          severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          identifier: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
    nextSteps: { type: 'array', items: { type: 'string' } },
    crossCuttingObservations: { type: 'array', items: { type: 'string' } },
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
    log(`throttledFanout: ${dropped.length} unit(s) still failed after retry; they will be reported as not-inspected`)
  }
  return { results: out, dropped }
}

// Group patches into work units. Complex (large source) or high-interaction patches each get a
// solo unit for deep, isolated inspection; small independent patches are batched so fan-out and
// tokens stay bounded. interactionRisk and sourceLines come from the inventory agent.
const SOLO_LINE_THRESHOLD = 700
const BATCH_SIZE = 5

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

// Trim a full inspection down to what the synthesizer needs to reason about severity. The full
// objects (anchorsChecked detail, paste-ready test code) are carried in the workflow return
// value and the code-side testHardening rollup, so re-feeding them to the synthesis agent would
// just balloon tokens for no added signal.
function compactInspection(i) {
  return {
    tag: i.tag,
    status: i.status,
    verifyVerdict: i.verifyVerdict,
    falsePositive: i.falsePositiveRisk?.rating ?? null,
    missedBug: i.missedBugRisk?.rating ?? null,
    concerns: i.concerns ?? [],
    robustnessNotes: (i.robustnessNotes ?? []).slice(0, 3),
    keyEvidence: (i.evidence ?? []).slice(0, 2),
    testCoverageNote: i.testCoverageNote ?? null,
    hasTestHardeningGaps: !!(i.testHardening && ((i.testHardening.gaps?.length) || (i.testHardening.assertions?.length))),
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

const mode = argsObj.mode === 'quick' || argsObj.mode === 'standard'
  ? argsObj.mode
  : 'full'
const groupFilter = typeof argsObj.group === 'string' ? argsObj.group : null
const tagFilter = typeof argsObj.tag === 'string'
  ? argsObj.tag.split(',').map((s) => s.trim()).filter(Boolean)
  : Array.isArray(argsObj.tag) ? argsObj.tag : null
const focus = typeof argsObj.focus === 'string' && argsObj.focus.trim()
  ? `\nUser focus: ${argsObj.focus.trim()}`
  : ''

const runPipelineInteraction = mode === 'full'
const runDocsAndCounts = mode !== 'quick'

phase('PatchInspection')
const inventory = await agent(
  `Discover the cc-enhanced patch inventory and identify the current clean bundle.

Steps:
1. Determine the currently promoted version (run \`mise run status\` or read \`claude --version\` output). Set currentVersion.
2. Set cleanBundlePath to versions_clean/<currentVersion>/cli.js. If that file does not exist, fall back to the highest-numbered subdirectory under versions_clean/ that has a cli.js. If none exist, set outcome=blocked with a blockedReason explaining the user should run mise run native:pull first.
3. Read src/patches/index.ts to enumerate every patch. For each: tag, sourceFile (e.g. src/patches/<tag>.ts), group (look up in src/patch-metadata.ts BY_TAG).
4. For every patch set sourceLines: run a single command like \`wc -l src/patches/*.ts\` (or rg -c '.' per file) and record the line count of each patch source. This drives whether a patch is inspected solo or batched, so populate it for all patches.
5. For every patch set interactionRisk: read the "Pipeline Ordering" section of CLAUDE.md (the shared-visitor-kinds table and the known rewrite-cascade note). Mark interactionRisk=high for any patch named in that table or in a rewrite-cascade interaction; mark interactionRisk=low otherwise.

If everything resolves, set outcome=ready. Otherwise set outcome=blocked with blockedReason.

Do not modify files. Do not run mise run native:update, native:fetch, native:pull, native:promote, or any write-side command. Do not commit.${focus}`,
  {
    label: 'patch inventory',
    phase: 'PatchInspection',
    schema: INVENTORY_SCHEMA,
  },
)

if (!inventory || inventory.outcome === 'blocked') {
  return {
    status: 'blocked',
    inventory,
    summary: inventory?.blockedReason ?? 'inventory phase returned null',
  }
}

const allPatches = inventory.patches ?? []
const cleanBundle = inventory.cleanBundlePath

if (!cleanBundle) {
  return {
    status: 'blocked',
    inventory,
    summary: 'inventory reported ready but did not provide a cleanBundlePath; cannot inspect against an undefined bundle.',
  }
}

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
    inventory,
    summary: `No patches matched the requested scope (group=${groupFilter ?? 'none'}, tag=${tagFilter ? tagFilter.join(',') : 'none'}). Nothing to inspect.`,
  }
}

const units = buildWorkUnits(patchesInScope)
log(`PatchInspection: ${patchesInScope.length} patch(es) in ${units.length} work unit(s) (${units.filter((u) => u.kind === 'solo').length} solo, ${units.filter((u) => u.kind === 'batch').length} batched)`)

const runInspectUnit = (unit) => {
  const list = unit.patches
    .map((p) => `- \`${p.tag}\` (source: ${p.sourceFile}${p.group ? `, group: ${p.group}` : ''})`)
    .join('\n')
  const deepNote = unit.kind === 'solo'
    ? 'This patch is large or high-interaction. Inspect it deeply. If it appears in the CLAUDE.md Pipeline Ordering shared-visitor table, explicitly reason about how its mutation could interact with sibling patches registering visitors for the same AST node kind in the same pass, and whether its anchor could be neutralized by another patch (rewrite-cascade).'
    : 'These are smaller, lower-interaction patches grouped for efficiency. Inspect each one fully and independently, and return exactly one entry per patch in inspections[], in the order listed.'
  return agent(
    `Inspect the following cc-enhanced patch(es) against the clean bundle ${cleanBundle}. This is a robustness audit, not a failure diagnosis.

Patches in this unit:
${list}

${deepNote}

For EACH patch, in one source read, produce anchor inspection + verify() robustness + test-hardening:

1. Read the patch source file in full. Extract every anchor: string literals, object property names, AST structural patterns, what verify() asserts, what string() replaces if present.
2. For each anchor, search ${cleanBundle} with rg -n for hits + line numbers. This rg use is the cc-enhanced cli.js exception for minified bundle anchor text; do not generalize it to ordinary source-code search. For each anchor record: hits (count), ambiguity (none / multiple-matches / context-dependent), fragility (low / medium / high).
3. Classify status: OK / DRIFT / BROKEN / UNKNOWN. Provide structuralContext, concerns, and evidence (file:line citations). Note robustness issues in robustnessNotes.
4. verify() robustness (reuse the same source you already read; do NOT re-read it in a separate pass):
   - whatVerifyChecks: one paragraph on exactly what invariants verify() asserts.
   - falsePositiveRisk { rating: low|medium|high, scenarios }: cases where verify() returns failure even though the patch did the right thing (e.g. it checks a property a sibling patch may legitimately remove; a count-based check perturbed by a benign upstream change).
   - missedBugRisk { rating, scenarios }: cases where the mutation could be wrong but verify() still returns true (e.g. it checks "property exists" but the mutation set the wrong value; it checks only one of several invariants the mutation depends on).
   - verifyVerdict: robust / fragile / weak / unknown. suggestedHardening if not robust.
5. testCoverageNote: existing | missing | needs new fixture; put file:line evidence or the specific gap in testCoverageEvidence.
6. testHardening: read src/patches/<tag>.test.ts and identify what the test plus verify() do NOT lock down such that a future upstream change could drift undetected (anchor hit-counts, the specific occurrence index, post-mutation invariants, structural context). For each gap, write a concrete node:test assertion matching the conventions already in that test file (node:test + node:assert/strict, the helpers it already imports, no reliance on minified identifier names) that a future mise run verify:patches would catch the drift with. Populate currentCoverage, gaps, and assertions (each with rationale, the anchor it locks, and paste-ready code).

Return inspections: one object per patch (tag, status, anchorsChecked, structuralContext, concerns, evidence, robustnessNotes, whatVerifyChecks, verifyVerdict, falsePositiveRisk, missedBugRisk, suggestedHardening, testCoverageNote, testCoverageEvidence, testHardening).

Do not run the patcher or verify:patches. Do not modify any files.`,
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

const { results: unitResults, dropped: droppedUnits } = await throttledFanout(units, runInspectUnit)
const confirmedInspections = unitResults
  .filter(Boolean)
  .flatMap((r) => r.inspections ?? [])
  .filter(Boolean)
const notInspectedTags = droppedUnits.flatMap((u) => u.patches.map((p) => p.tag))

// Consolidated test-hardening rollup, assembled in code (no synthesis-agent round trip). One
// entry per inspected patch that has at least one gap or assertion.
const testHardening = confirmedInspections
  .filter((i) => i.testHardening && ((i.testHardening.gaps?.length) || (i.testHardening.assertions?.length)))
  .map((i) => ({
    tag: i.tag,
    currentCoverage: i.testHardening.currentCoverage ?? null,
    gaps: i.testHardening.gaps ?? [],
    assertions: i.testHardening.assertions ?? [],
  }))

let pipelineInteraction = null
if (runPipelineInteraction) {
  phase('PipelineInteraction')
  pipelineInteraction = await agent(
    `Analyze cross-patch interactions in the cc-enhanced AST pass pipeline. Find risks where patches could step on each other.

Methodology:
1. Read src/ast-pass-engine.ts to understand how the combined-pass engine merges visitors and what pass ordering looks like.
2. Read src/patch-runner.ts to understand string-phase ordering, parse, combined traversal, print, verify, signature, write sequencing.
3. Read every astPasses-bearing patch in src/patches/ (each visitor has pass: 'discover' | 'mutate' | 'finalize').
4. Identify risks:
   - shared-node-type: two patches register visitors for the same AST node kind in the same pass.
   - overlap-range: two patches mutate overlapping code ranges.
   - rewrite-cascade: one patch's mutation neutralizes another's anchor (e.g. one patch rewriting another's guard test to a constant before later passes run).
   - pass-order-coupling: a patch's verify() depends on something another patch's mutation produces or consumes.
   - other.
5. For each risk: kind, patchesInvolved, description, severity, evidence (file:line citations), suggestedTest.

Provide a short summary covering total risks found and the highest-severity ones. Return the risks array.

Do not modify any files.${focus}`,
    {
      label: 'pipeline interaction',
      phase: 'PipelineInteraction',
      schema: PIPELINE_INTERACTION_SCHEMA,
    },
  )
}

let docs = null
if (runDocsAndCounts) {
  phase('DocsAndCounts')
  docs = await agent(
    `Verify cc-enhanced patch counts and references across documentation. Find drift.

Steps:
1. Count actual patches: list files matching src/patches/*.ts excluding *.test.ts, ast-helpers.ts, prompt-policy.ts, and other non-patch helpers. Cross-reference with BY_TAG in src/patch-metadata.ts. Set actualPatchCount.
2. Find every patch-count number in README.md (intro paragraph, badge). Local files are the authoritative source.
3. Optional, network, skip-on-failure: only if it is convenient and gh is authenticated, also read the GitHub repo description with a single \`gh repo view --json description --jq '.description'\` and check it for a patch count. If gh is unavailable, unauthenticated, or errors, skip this silently; do not block, retry, or treat it as a finding. Set outcome=partial-evidence only when a LOCAL source could not be read.
4. Compare each found count against actualPatchCount. count-mismatch findings for any divergence.
5. Find stale references:
   - Patches mentioned by tag in README.md, AGENTS.md, CLAUDE.md, or .claude/skills/ that do not exist in src/patches/.
   - Patches that exist in src/patches/ but are not mentioned in BY_TAG.
   - Group names in CLAUDE.md or README.md that do not match groups in src/patch-metadata.ts.
6. For each finding: kind, location, description, severity, suggestedFix.

outcome:
- consistent: counts match across all readable sources, no stale references.
- inconsistent: any count mismatch or stale reference.
- partial-evidence: a local source could not be read.

Do not modify any files.`,
    {
      label: 'docs and counts',
      phase: 'DocsAndCounts',
      schema: DOCS_SCHEMA,
    },
  )
}

phase('Synthesize')
const phasesRun = ['PatchInspection']
if (runPipelineInteraction) phasesRun.push('PipelineInteraction')
if (runDocsAndCounts) phasesRun.push('DocsAndCounts')

const audit = await agent(
  `Synthesize a unified audit report from the available inputs.

Scope used:
- mode: ${mode}
- groupFilter: ${groupFilter ?? 'none'}
- tagFilter: ${tagFilter ? tagFilter.join(',') : 'none'}
- patches inspected: ${confirmedInspections.length} / ${allPatches.length} (${patchesSkipped} out of scope)
- patches NOT inspected after retry (treat as UNKNOWN): ${notInspectedTags.length ? notInspectedTags.join(', ') : 'none'}
- phases run: ${phasesRun.join(', ')}

Each patch inspection already includes its verify() robustness (verifyVerdict, falsePositive, missedBug). Treat verifier-robustness findings as source=verifier-audit when you build the findings array.

Patch inspections (compact projection; full anchor detail and test code are retained out of band):
${JSON.stringify(confirmedInspections.map(compactInspection))}

Pipeline interaction analysis (null if skipped in this mode):
${JSON.stringify(pipelineInteraction)}

Docs and counts (null if skipped in this mode):
${JSON.stringify(docs)}

Build counts where data exists (patchesOk/Drift/Broken from status; verifiersRobust/Fragile/Weak from verifyVerdict; pipelineRisksHigh; docsFindings). Build a single findings array combining sources that ran, each tagged with its source. Severity rubric:
- BROKEN patch, weak verify(), critical pipeline risk, count-mismatch on production-claimed count: critical
- DRIFT patch with concerns, fragile verify() with realistic scenarios, high pipeline risk, stale-reference on user-facing doc: high
- robustness notes, medium pipeline risk, medium-severity docs finding: medium
- ambiguity notes, low pipeline risk, cosmetic docs: low
- minor robustness observations: nit

For each patch in "patches NOT inspected after retry", emit a finding with source=not-inspected, severity=medium, identifier=tag, describing that it could not be inspected this run and recommending a re-run (optionally a narrower tag filter).

Order findings by severity, then by source.

Status:
- healthy: no critical or high findings.
- issues-found: at least one high finding but no critical.
- critical: at least one critical finding.
- blocked: phases failed.

nextSteps: concrete actions in priority order. Always include "mise run verify:patches" and specific source fixes. If any patch has test-hardening gaps (hasTestHardeningGaps=true), include a step to apply the testHardening assertions returned by this workflow.

crossCuttingObservations: surface patterns across sources.

Set scope = {mode, patchesInspected, patchesSkipped, patchesNotInspected, phasesRun}.

Do not write code, edit files, or commit.${focus}`,
  {
    label: 'audit synthesis',
    phase: 'Synthesize',
    schema: AUDIT_SCHEMA,
  },
)

return {
  scope: { mode, groupFilter, tagFilter, phasesRun },
  inventory,
  patchInspections: confirmedInspections,
  notInspectedTags,
  pipeline: pipelineInteraction,
  docs,
  audit,
  testHardening,
}
