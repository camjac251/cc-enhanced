export const meta = {
  name: 'patch-audit',
  description: 'Deep health audit of cc-enhanced patches through cli.js inspection plus verifier robustness, pipeline interaction, and docs cross-check',
  whenToUse: 'Use in cc-enhanced for periodic patch health checks or before a push. Goes beyond mise run verify:patches by inspecting every patch in scope against the current clean bundle, auditing each verify() function for false-positive and missed-bug risk, identifying cross-patch interactions in the AST pipeline, and verifying patch counts across docs. Accepts mode/group/tag filters via args. Read-only.',
  phases: [
    { title: 'PatchInspection', detail: 'patches in scope inspected in parallel via patch-verifier against the current clean bundle' },
    { title: 'VerifierAudit', detail: 'verify() functions audited in parallel for false-positive and missed-bug risk (full mode only)' },
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
        required: ['tag', 'sourceFile'],
        properties: {
          tag: { type: 'string' },
          sourceFile: { type: 'string' },
          group: { type: 'string' },
        },
      },
    },
    blockedReason: { type: 'string' },
  },
}

const PATCH_INSPECTION_SCHEMA = {
  type: 'object',
  required: ['tag', 'status', 'concerns'],
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
  },
}

const VERIFIER_AUDIT_SCHEMA = {
  type: 'object',
  required: ['tag', 'verdict', 'concerns'],
  properties: {
    tag: { type: 'string' },
    verdict: { enum: ['robust', 'fragile', 'weak', 'unknown'] },
    whatVerifyChecks: { type: 'string' },
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
    concerns: { type: 'array', items: { type: 'string' } },
    suggestedHardening: { type: 'string' },
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
          source: { enum: ['patch-inspection', 'verifier-audit', 'pipeline-interaction', 'docs-and-counts'] },
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

const runVerifierAudit = mode === 'full'
const runPipelineInteraction = mode === 'full'
const runDocsAndCounts = mode !== 'quick'

phase('PatchInspection')
const inventory = await agent(
  `Discover the cc-enhanced patch inventory and identify the current clean bundle.

Steps:
1. Determine the currently promoted version (run \`mise run status\` or read \`claude --version\` output). Set currentVersion.
2. Set cleanBundlePath to versions_clean/<currentVersion>/cli.js. If that file does not exist, fall back to the highest-numbered subdirectory under versions_clean/ that has a cli.js. If none exist, set outcome=blocked with a blockedReason explaining the user should run mise run native:pull first.
3. Read src/patches/index.ts to enumerate every patch. For each: tag, sourceFile (e.g. src/patches/<tag>.ts), group (look up in src/patch-metadata.ts BY_TAG).

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

const filteredPatches = allPatches.filter((p) => {
  if (groupFilter && p.group !== groupFilter) return false
  if (tagFilter && !tagFilter.includes(p.tag)) return false
  return true
})

const patchesInScope = mode === 'quick' && !groupFilter && !tagFilter
  ? filteredPatches.filter((p) => ['Prompt', 'System', 'Tooling'].includes(p.group))
  : filteredPatches

const patchesSkipped = allPatches.length - patchesInScope.length

const patchInspections = await parallel(
  patchesInScope.map((p) => () => agent(
    `Deep-inspect the cc-enhanced patch \`${p.tag}\` (source: ${p.sourceFile}) against ${cleanBundle}. This is a robustness audit, not a failure diagnosis.

Methodology:
1. Read ${p.sourceFile} in full. Extract every anchor.
2. For each anchor, search ${cleanBundle} with rg -n for hits + line numbers.
3. For each anchor, evaluate:
   - hits: total matches in the clean bundle
   - ambiguity: none, multiple-matches, or context-dependent
   - fragility: low, medium, or high
4. Classify the patch as OK, DRIFT, BROKEN, or UNKNOWN.
5. Note robustness issues in robustnessNotes.

Return anchorsChecked, structuralContext, concerns, evidence, robustnessNotes.

Do not run the patcher, do not modify any files.`,
    {
      label: `inspect:${p.tag}`,
      phase: 'PatchInspection',
      schema: PATCH_INSPECTION_SCHEMA,
      agentType: 'patch-verifier',
    },
  )),
)

const confirmedInspections = (patchInspections ?? []).filter(Boolean)

let confirmedVerifierAudits = []
if (runVerifierAudit) {
  phase('VerifierAudit')
  const verifierAudits = await parallel(
    patchesInScope.map((p) => () => agent(
      `Audit the verify() function of cc-enhanced patch \`${p.tag}\` (source: ${p.sourceFile}). The goal is to assess whether verify() catches real drift and whether it can produce false positives. This is source-code reasoning, not bundle inspection.

Methodology:
1. Read ${p.sourceFile} in full. Focus on the verify() function and helpers from src/patches/ast-helpers.ts.
2. whatVerifyChecks: one-paragraph description of exactly what invariants verify() asserts.
3. False-positive risk: scenarios where verify() returns failure even though the patch did the right thing. Examples: verify() checks a property name a sibling patch might legitimately remove; verify() does a count-based check perturbed by benign upstream changes.
4. Missed-bug risk: scenarios where the patch's mutation could be wrong but verify() still returns true. Examples: verify() checks "property exists" but the mutation set it to the wrong value; verify() checks only one of several invariants the mutation depends on.
5. Verdict: robust / fragile / weak / unknown.
6. Suggest hardening if not robust.

Return verdict, whatVerifyChecks, falsePositiveRisk, missedBugRisk, concerns, suggestedHardening.

You do not need to search cli.js for this audit; you are reasoning about the verifier from the patch source. Do not run the patcher. Do not modify any files.`,
      {
        label: `verify-audit:${p.tag}`,
        phase: 'VerifierAudit',
        schema: VERIFIER_AUDIT_SCHEMA,
      },
    )),
  )
  confirmedVerifierAudits = (verifierAudits ?? []).filter(Boolean)
}

let pipeline = null
if (runPipelineInteraction) {
  phase('PipelineInteraction')
  pipeline = await agent(
    `Analyze cross-patch interactions in the cc-enhanced AST pass pipeline. Find risks where patches could step on each other.

Methodology:
1. Read src/ast-pass-engine.ts to understand how the combined-pass engine merges visitors and what pass ordering looks like.
2. Read src/patch-runner.ts to understand string-phase ordering, parse, combined traversal, print, verify, signature, write sequencing.
3. Read every astPasses-bearing patch in src/patches/ (each visitor has pass: 'discover' | 'mutate' | 'finalize').
4. Identify risks:
   - shared-node-type: two patches register visitors for the same AST node kind in the same pass.
   - overlap-range: two patches mutate overlapping code ranges.
   - rewrite-cascade: one patch's mutation neutralizes another's anchor (e.g. plan-diff-ui rewriting Edit's startsWith guard before later passes).
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
2. Find every patch-count number in:
   - README.md (intro paragraph, badge)
   - CLAUDE.md ("applies N verifiable patches")
   - GitHub repo description: resolve the repo with \`gh repo view --json nameWithOwner --jq '.nameWithOwner'\` and then \`gh api repos/<owner>/<repo> --jq '.description'\`. Use the dynamic resolution; do not hardcode the owner/repo.
3. Compare each found count against actualPatchCount. count-mismatch findings for any divergence.
4. Find stale references:
   - Patches mentioned by tag in README.md, CLAUDE.md, or .claude/skills/ that do not exist in src/patches/.
   - Patches that exist in src/patches/ but are not mentioned in BY_TAG.
   - Group names in CLAUDE.md or README.md that do not match groups in src/patch-metadata.ts.
5. For each finding: kind, location, description, severity, suggestedFix.

outcome:
- consistent: counts match across all sources, no stale references.
- inconsistent: any count mismatch or stale reference.
- partial-evidence: some sources could not be read (e.g. gh api unauthenticated).

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
if (runVerifierAudit) phasesRun.push('VerifierAudit')
if (runPipelineInteraction) phasesRun.push('PipelineInteraction')
if (runDocsAndCounts) phasesRun.push('DocsAndCounts')

const audit = await agent(
  `Synthesize a unified audit report from the available inputs.

Scope used:
- mode: ${mode}
- groupFilter: ${groupFilter ?? 'none'}
- tagFilter: ${tagFilter ? tagFilter.join(',') : 'none'}
- patches inspected: ${confirmedInspections.length} / ${allPatches.length} (${patchesSkipped} skipped)
- phases run: ${phasesRun.join(', ')}

Patch inspections:
${JSON.stringify(confirmedInspections)}

Verifier audits (empty if skipped in this mode):
${JSON.stringify(confirmedVerifierAudits)}

Pipeline interaction analysis (null if skipped in this mode):
${JSON.stringify(pipeline)}

Docs and counts (null if skipped in this mode):
${JSON.stringify(docs)}

Build counts where data exists. Build a single findings array combining sources that ran, each tagged with its source. Severity rubric:
- BROKEN patch, weak verify(), critical pipeline risk, count-mismatch on production-claimed count: critical
- DRIFT patch with concerns, fragile verify() with realistic scenarios, high pipeline risk, stale-reference on user-facing doc: high
- robustness notes, medium pipeline risk, medium-severity docs finding: medium
- ambiguity notes, low pipeline risk, cosmetic docs: low
- minor robustness observations: nit

Order findings by severity, then by source.

Status:
- healthy: no critical or high findings.
- issues-found: at least one high finding but no critical.
- critical: at least one critical finding.
- blocked: phases failed.

nextSteps: concrete actions in priority order. Always include "mise run verify:patches" and specific source fixes.

crossCuttingObservations: surface patterns across sources.

Set scope = {mode, patchesInspected, patchesSkipped, phasesRun}.

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
  verifierAudits: confirmedVerifierAudits,
  pipeline,
  docs,
  audit,
}
