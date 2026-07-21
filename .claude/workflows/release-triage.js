export const meta = {
  name: 'release-triage',
  description: 'Triage an upstream release: sequential focused bundle diffs, feature inventory, patch-risk clustering, prompt-surface impact, and a release report',
  whenToUse: 'Use in cc-enhanced when new upstream releases land and you want the full drift picture before touching patch code. Requires the clean bundles to already exist under versions_clean/ (fast-fails with the exact native:pull commands otherwise). One agent runs the mise run diff passes strictly sequentially (bundle diffs are memory-heavy and never overlap); three analysts then work from the reports in parallel (feature inventory, patch-risk clusters, watched prompt-surface impact); synthesis returns an upstream-tracking-style report with next steps. Release notes are treated as insufficient by design: the bundle diff is the source of truth. Read-only apart from the local diff cache. Args: {old, new, mid, focus, models}.',
  phases: [
    { title: 'Inventory', detail: 'resolve versions, verify clean bundles exist, enumerate patch tags and watched surfaces' },
    { title: 'Diff', detail: 'matrix/pairwise diff plus focused passes, run strictly sequentially by one agent (memory-heavy, never concurrent)' },
    { title: 'Analyze', detail: 'parallel analysts: feature inventory, patch-risk clusters, prompt-surface impact' },
    { title: 'Synthesize', detail: 'upstream-tracking-style release report with next steps' },
  ],
}

const INVENTORY_SCHEMA = {
  type: 'object',
  required: ['outcome', 'oldVersion', 'newVersion', 'bundlePaths'],
  properties: {
    outcome: { enum: ['ready', 'missing-bundle', 'blocked'] },
    oldVersion: { type: 'string' },
    newVersion: { type: 'string' },
    midVersion: { type: 'string' },
    bundlePaths: {
      type: 'object',
      properties: {
        old: { type: 'string' },
        mid: { type: 'string' },
        new: { type: 'string' },
      },
    },
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
    surfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          extractorAnchors: { type: 'array', items: { type: 'string' } },
          optional: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    blockedReason: { type: 'string' },
  },
}

const DIFF_SCHEMA = {
  type: 'object',
  required: ['passes'],
  properties: {
    passes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['focus', 'summary'],
        properties: {
          focus: { type: 'string' },
          summary: { type: 'string' },
          highlights: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    overall: {
      type: 'object',
      properties: {
        added: { type: 'number' },
        removed: { type: 'number' },
        countChanged: { type: 'number' },
      },
    },
    concerns: { type: 'array', items: { type: 'string' } },
  },
}

const FEATURES_SCHEMA = {
  type: 'object',
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    newEnvVars: { type: 'array', items: { type: 'string' } },
    newCommands: { type: 'array', items: { type: 'string' } },
    settingsChanges: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const PATCH_RISK_SCHEMA = {
  type: 'object',
  required: ['risks', 'clusters', 'summary'],
  properties: {
    summary: { type: 'string' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tag', 'severity', 'reason'],
        properties: {
          tag: { type: 'string' },
          severity: { enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'tagsInvolved'],
        properties: {
          description: { type: 'string' },
          tagsInvolved: { type: 'array', items: { type: 'string' } },
          sharedShape: { type: 'string' },
          recommendedFix: { type: 'string' },
        },
      },
    },
  },
}

const SURFACE_IMPACT_SCHEMA = {
  type: 'object',
  required: ['impacted', 'summary'],
  properties: {
    summary: { type: 'string' },
    impacted: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'status'],
        properties: {
          path: { type: 'string' },
          status: { enum: ['likely-intact', 'at-risk', 'removed', 'unknown'] },
          change: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          action: { type: 'string' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['status', 'headline', 'nextSteps'],
  properties: {
    status: { enum: ['low-risk', 'patch-fixes-likely', 'major-drift', 'blocked'] },
    headline: { type: 'string' },
    themes: { type: 'array', items: { type: 'string' } },
    patchRisks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tag', 'severity', 'reason'],
        properties: {
          tag: { type: 'string' },
          severity: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    clusters: { type: 'array', items: { type: 'string' } },
    surfaceImpacts: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
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

// Model tiers: mechanical work on sonnet, the patch-risk reasoning on opus, synthesis inherits
// the session model. Override via args.models ({mechanical, deep}).
const models = {
  mechanical: typeof argsObj.models?.mechanical === 'string' ? argsObj.models.mechanical : 'sonnet',
  deep: typeof argsObj.models?.deep === 'string' ? argsObj.models.deep : 'opus',
}
const oldArg = typeof argsObj.old === 'string' ? argsObj.old : null
const newArg = typeof argsObj.new === 'string' ? argsObj.new : null
const midArg = typeof argsObj.mid === 'string' ? argsObj.mid : null
const focus = typeof argsObj.focus === 'string' && argsObj.focus.trim()
  ? `\nUser focus: ${argsObj.focus.trim()}`
  : ''

phase('Inventory')
const inventory = await agent(
  `Resolve the cc-enhanced release-triage inventory.

Steps:
1. Determine the promoted version (run mise run status or read claude --version output).
2. List versions_clean/ subdirectories that contain a cli.js.
3. Resolve versions: newVersion = ${newArg ?? 'the highest-numbered pulled version'}; oldVersion = ${oldArg ?? 'the promoted version, falling back to the second-highest pulled version if the promoted one is not pulled'}; midVersion = ${midArg ?? 'unset (pairwise diff)'}.
4. Set bundlePaths to versions_clean/<version>/cli.js for each resolved version. If any needed bundle is missing, set outcome=missing-bundle and put the exact command for each missing one in notes (mise run native:pull -- <version>), then stop.
5. Read src/patches/index.ts to enumerate patches: tag, sourceFile, group (from BY_TAG in src/patch-metadata.ts).
6. Read src/verification/prompt-surface-rules.ts to enumerate watched surfaces: path, optional, and extractorAnchors (the literal strings scripts/export-prompts.ts uses to locate the surface in cli.js).

If everything resolves, set outcome=ready; if fundamental files are missing, outcome=blocked with blockedReason.

Do not run mise run native:update, native:fetch, native:pull, native:promote, or any write-side command. Do not run verify:patches, mise run diff, bun run inspect, or prompts:export either: the diff phase owns the only bundle parsing in this workflow. Do not modify any files.${focus}`,
  {
    label: 'release inventory',
    phase: 'Inventory',
    schema: INVENTORY_SCHEMA,
    model: models.mechanical,
  },
)

if (!inventory || inventory.outcome === 'blocked') {
  return {
    status: 'blocked',
    inventory,
    summary: inventory?.blockedReason ?? 'inventory phase returned null',
  }
}

if (inventory.outcome === 'missing-bundle') {
  return {
    status: 'missing-bundle',
    inventory,
    summary: (inventory.notes ?? []).join(' ') || 'a required clean bundle is not pulled; see notes for the native:pull commands',
  }
}

const oldPath = inventory.bundlePaths?.old
const newPath = inventory.bundlePaths?.new
const midPath = inventory.bundlePaths?.mid

if (!oldPath || !newPath) {
  return {
    status: 'blocked',
    inventory,
    summary: 'inventory reported ready but did not provide both bundle paths',
  }
}

phase('Diff')
const diff = await agent(
  `Run the cc-enhanced release diffs and summarize each pass. These commands parse whole bundles and are MEMORY-HEAVY: run them STRICTLY SEQUENTIALLY, one at a time, each exactly once, waiting for each to exit before starting the next. Never run two concurrently. The --cache flag only writes a local diff cache and is explicitly allowed despite the write guard below.

Bundles:
- old: ${oldPath}${midPath ? `\n- mid: ${midPath}` : ''}
- new: ${newPath}

Commands, in order:
1. ${midPath ? `mise run diff -- matrix ${oldPath} ${midPath} ${newPath} --cache` : `mise run diff -- ${oldPath} ${newPath} --cache`}
2. mise run diff -- ${oldPath} ${newPath} --focus commands --cache
3. mise run diff -- ${oldPath} ${newPath} --focus env --cache
4. mise run diff -- ${oldPath} ${newPath} --focus settings --cache
5. mise run diff -- ${oldPath} ${newPath} --focus rewrites --cache
6. mise run diff -- ${oldPath} ${newPath} --focus patches --cache
7. Only if exported-prompts/${inventory.newVersion}/ exists: mise run diff -- ${oldPath} ${newPath} --focus prompts --prompt-export exported-prompts/${inventory.newVersion} --cache. Otherwise skip it and add a concern noting the prompts focus was skipped (no export).

For each pass produce: focus, a 2-4 sentence summary, and up to 15 verbatim high-signal highlight lines (added/removed/rewritten surfaces an analyst should look at). Set overall added/removed/countChanged from the main diff output.

These diffs are the ONLY bundle-parsing commands in this entire workflow run; do not run bun run inspect, verify:patches, or prompts:export in addition. Do not run native:update, native:fetch, native:pull, or native:promote. Do not modify any files.${focus}`,
  {
    label: 'sequential bundle diffs',
    phase: 'Diff',
    schema: DIFF_SCHEMA,
    model: models.mechanical,
  },
)

if (!diff) {
  return { status: 'blocked', inventory, summary: 'diff phase returned null' }
}

phase('Analyze')
const patchFocusPasses = (diff.passes ?? []).filter((p) => p.focus === 'patches' || p.focus === 'rewrites' || p.focus === 'main' || p.focus === 'matrix')
const [features, patchRisk, surfaceImpact] = await parallel([
  () => agent(
    `Build the release feature inventory for cc-enhanced upstream tracking from the diff pass summaries below.

Diff passes: ${JSON.stringify(diff.passes ?? [])}
Overall counts: ${JSON.stringify(diff.overall ?? null)}

Group changes into named themes with verbatim evidence surfaces. List newEnvVars, newCommands, and settingsChanges explicitly. Report vendored-library noise (protobuf descriptors and similar) as a note, never as a feature theme.

Work only from the inputs above; do not run any commands. Do not modify any files.`,
    { label: 'feature inventory', phase: 'Analyze', schema: FEATURES_SCHEMA, model: models.mechanical },
  ),
  () => agent(
    `Assess patch risk for the cc-enhanced patch set against this release diff.

Patches: ${JSON.stringify(inventory.patches ?? [])}
Relevant diff passes: ${JSON.stringify(patchFocusPasses)}

For each patch plausibly touched by a flagged surface: read its source file, judge whether the change hits an anchor the patch depends on, and record a risk (tag, severity high/medium/low, reason, evidence).

Cluster thinking is mandatory: when one shared upstream shape underlies several risks (element construction, a shared wrapper helper, a template wording family), record a cluster (description, tagsInvolved, sharedShape, recommendedFix) and recommend absorbing the change in the shared helpers (src/patches/ast-helpers.ts) rather than per-patch re-anchors. Historical precedent: an undocumented JSX runtime migration once broke five render-targeting patches at once, and the release notes never mentioned it. Treat release notes as incomplete by default.

Analysts run CONCURRENTLY and the diff phase already parsed the bundles: read repository files and rg them, but never run bundle-parsing commands (mise run diff, bun run inspect, verify:patches, prompts:export). Do not run the patcher. Do not modify any files.${focus}`,
    { label: 'patch-risk clusters', phase: 'Analyze', schema: PATCH_RISK_SCHEMA, model: models.deep },
  ),
  () => agent(
    `Use prompt-surface mode. For each watched surface below, check extractor-anchor reachability in the NEW clean bundle ${newPath} with rg -n (the cc-enhanced cli.js rg exception; do not generalize it). This is a CLEAN bundle: only pre-patch anchors are expected to exist; post-patch needles are out of scope here.

Surfaces: ${JSON.stringify(inventory.surfaces ?? [])}

For each surface: status likely-intact (anchors found with sane counts), at-risk (found but counts or context shifted), removed (required anchors absent; if the surface is marked optional, still report removed and say it is optional), or unknown. Include evidence (line numbers) and a one-line action.

Analysts run CONCURRENTLY: rg and bat are the only bundle access allowed; never run bundle-parsing commands (bun run inspect, mise run diff, verify:patches). Do not modify any files.`,
    { label: 'surface impact', phase: 'Analyze', schema: SURFACE_IMPACT_SCHEMA, agentType: 'patch-verifier', model: models.mechanical },
  ),
])

phase('Synthesize')
const report = await agent(
  `Synthesize the release-triage report (upstream-tracking style) for cc-enhanced.

Versions: old ${inventory.oldVersion}, new ${inventory.newVersion}${inventory.midVersion ? `, mid ${inventory.midVersion}` : ''}
Feature inventory (null means that analyst failed; say so in notes): ${JSON.stringify(features)}
Patch risk: ${JSON.stringify(patchRisk)}
Surface impact: ${JSON.stringify(surfaceImpact)}
Diff concerns: ${JSON.stringify(diff.concerns ?? [])}

status rubric:
- low-risk: no medium-or-higher patch risk and no at-risk/removed non-optional surface.
- patch-fixes-likely: specific risks exist and each has a clear fix direction.
- major-drift: any cluster, or several high risks at once.
- blocked: analysts failed to produce usable input.

headline: one sentence for the release. themes: condensed one-liners. patchRisks and clusters carried through ordered by severity. surfaceImpacts: non-intact surfaces only.

nextSteps in priority order. If clusters exist, the shared-helper fix comes first. Always include: run the patch-update workflow (delta mode for routine releases, full before promoting), then mise run verify:patches. End with updating the upstream-tracking memory note for this release.

Work only from the inputs above; do not run any commands. Do not modify any files.${focus}`,
  {
    label: 'release report',
    phase: 'Synthesize',
    schema: REPORT_SCHEMA,
  },
)

return { inventory, diff, features, patchRisk, surfaceImpact, report }
