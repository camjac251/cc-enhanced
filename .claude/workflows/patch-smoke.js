export const meta = {
  name: 'patch-smoke',
  description: 'Post-promote smoke check: verify the PROMOTED binary carries the current patch roster and post-patch invariants, catching stale promotes and verify-green-but-missing drift',
  whenToUse: 'Use in cc-enhanced after mise run native:update promotes a binary, or whenever unsure the live binary matches current patch sources. Compares the signature tag list embedded in claude --version against the current roster, unpacks the promoted binary (single agent, memory-heavy, runs alone), then probes each patch for the post-patch needles its verify() asserts. This is the inverse of the clean-bundle checks: post-patch needles are expected PRESENT in a patched bundle, so absence is real signal. Two historical incidents shipped through a green verify but were broken or absent live; this closes that gap as far as headless checks can. Read-only on the repo; writes only a scratch unpack. Args: {focus, models}.',
  phases: [
    { title: 'Status', detail: 'promoted version, symlink chain, signature tag list vs current roster, recent patch-source changes' },
    { title: 'Unpack', detail: 'unpack the promoted binary to scratch (single agent, memory-heavy, runs alone)' },
    { title: 'Probes', detail: 'batched patch-verifier probes for post-patch invariants in the promoted bundle' },
    { title: 'Verdict', detail: 'pass / stale-promote / fail / inconclusive with exact next commands' },
  ],
}

const STATUS_SCHEMA = {
  type: 'object',
  required: ['outcome', 'rosterTags'],
  properties: {
    outcome: { enum: ['ready', 'blocked'] },
    promotedVersion: { type: 'string' },
    signatureTags: { type: 'array', items: { type: 'string' } },
    rosterTags: { type: 'array', items: { type: 'string' } },
    missingFromBinary: { type: 'array', items: { type: 'string' } },
    extraInBinary: { type: 'array', items: { type: 'string' } },
    symlinkHealthy: { type: 'boolean' },
    concerns: { type: 'array', items: { type: 'string' } },
    blockedReason: { type: 'string' },
  },
}

const UNPACK_SCHEMA = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: { enum: ['ok', 'failed'] },
    unpackedPath: { type: 'string' },
    reason: { type: 'string' },
  },
}

const PROBE_SCHEMA = {
  type: 'object',
  required: ['probes'],
  properties: {
    probes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tag', 'status'],
        properties: {
          tag: { type: 'string' },
          status: { enum: ['live', 'missing', 'ast-only', 'unknown'] },
          needlesChecked: {
            type: 'array',
            items: {
              type: 'object',
              required: ['needle', 'hits'],
              properties: {
                needle: { type: 'string' },
                hits: { type: 'number' },
              },
            },
          },
          evidence: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'nextSteps'],
  properties: {
    verdict: { enum: ['pass', 'stale-promote', 'fail', 'inconclusive'] },
    summary: { type: 'string' },
    staleTags: { type: 'array', items: { type: 'string' } },
    missingTags: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
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

// Probes are mechanical needle checks; only the verdict inherits the session model.
const models = {
  mechanical: typeof argsObj.models?.mechanical === 'string' ? argsObj.models.mechanical : 'sonnet',
}
const focus = typeof argsObj.focus === 'string' && argsObj.focus.trim()
  ? `\nUser focus: ${argsObj.focus.trim()}`
  : ''

phase('Status')
const statusRes = await agent(
  `Check whether the PROMOTED cc-enhanced binary matches the current patch roster.

Steps:
1. Run mise run status and claude --version. Record promotedVersion. The signature patch embeds the applied patch tag list in the version output; extract signatureTags from it. If no tag list is present, leave signatureTags empty and add a concern (the binary may be unpatched or predate the signature patch).
2. Run bun run cli --list and set rosterTags to every tag it shows (including signature).
3. missingFromBinary = roster tags absent from signatureTags (when signatureTags is non-empty); extraInBinary = signature tags absent from the roster.
4. Run git status --short src/patches/ and git log --oneline -5 -- src/patches/ and add concerns for uncommitted or recent patch-source changes, since the promoted binary may predate them.
5. Set symlinkHealthy from what mise run status reports about the symlink chain.

Set outcome=blocked only if the status commands themselves fail. Do not run mise run native:update or any promote/fetch/pull command, and do not run verify:patches, mise run diff, bun run inspect, native:unpack*, or prompts:export: the unpack happens in the next phase, alone. Do not modify any files.${focus}`,
  {
    label: 'promote status',
    phase: 'Status',
    schema: STATUS_SCHEMA,
    model: models.mechanical,
  },
)

if (!statusRes || statusRes.outcome === 'blocked') {
  return {
    status: 'blocked',
    statusRes,
    summary: statusRes?.blockedReason ?? 'status phase returned null',
  }
}

phase('Unpack')
const unpack = await agent(
  `Unpack the promoted cc-enhanced binary for probing. Run exactly ONE command, by itself (it is memory-heavy; run nothing else concurrently): mise run native:unpack-current -- <output-path>. Choose <output-path> inside the session scratchpad directory (never inside the repository, never under versions_clean/). On success set outcome=ok and unpackedPath to the exact path written. On failure set outcome=failed with the reason.

Run no other bundle-parsing command before or after it (no bun run inspect, mise run diff, verify:patches, prompts:export). Do not modify repository files. Do not run native:update, native:fetch, native:pull, or native:promote.`,
  {
    label: 'unpack promoted binary',
    phase: 'Unpack',
    schema: UNPACK_SCHEMA,
    model: models.mechanical,
  },
)

if (unpack?.outcome !== 'ok' || !unpack.unpackedPath) {
  return {
    status: 'inconclusive',
    statusRes,
    unpack,
    summary: unpack?.reason ?? 'could not unpack the promoted binary; probes skipped',
  }
}

phase('Probes')
const rosterTags = statusRes.rosterTags ?? []
const units = chunk(rosterTags, 8)
log(`Probes: ${rosterTags.length} patch(es) in ${units.length} unit(s) against ${unpack.unpackedPath}`)

const runProbe = (tags) => agent(
  `The bundle at ${unpack.unpackedPath} is the PROMOTED, ALREADY-PATCHED cli.js. Post-patch invariants are expected to be PRESENT here; a missing post-patch needle is real signal (a stale promote, or a patch that silently did not land). This is the INVERSE of clean-bundle semantics.

Patches in this unit:
${tags.map((t) => `- ${t} (source: src/patches/${t}.ts)`).join('\n')}

For EACH patch: read its source file and extract the post-patch evidence its verify() asserts (injected string literals, object keys, rewritten wording, added properties). Search ${unpack.unpackedPath} with rg -n for each (the cc-enhanced cli.js rg exception; do not generalize it). Status per patch:
- live: the key needles are present.
- missing: a needle verify() requires is absent.
- ast-only: verify() asserts only AST shapes with no stable searchable text; not a failure, note it.
- unknown: cannot determine.
Record needlesChecked (needle, hits) and evidence with line numbers. Return exactly one probes[] entry per patch, in the order listed.

Probes run CONCURRENTLY with each other: never run bundle-parsing commands (bun run inspect, mise run diff, native:unpack*, prompts:export); rg -n on ${unpack.unpackedPath} plus bat -r for context are the only bundle access allowed. Do not run the patcher or verify:patches. Do not modify any files.`,
  {
    label: `probe:${tags.length}x`,
    phase: 'Probes',
    schema: PROBE_SCHEMA,
    agentType: 'patch-verifier',
    model: models.mechanical,
  },
)

// Small staggered fan-out: warm the prompt cache on the first unit, then slices of 4.
// A unit that returns null is surfaced as not-probed rather than retried; the verdict
// agent treats a large not-probed set as inconclusive.
const probeUnitResults = []
if (units.length > 0) {
  probeUnitResults.push(await runProbe(units[0]))
  for (let i = 1; i < units.length; i += 4) {
    const got = await parallel(units.slice(i, i + 4).map((u) => () => runProbe(u)))
    probeUnitResults.push(...got)
  }
}
const flatProbes = probeUnitResults.filter(Boolean).flatMap((r) => r.probes ?? []).filter(Boolean)
const probedTags = new Set(flatProbes.map((p) => p.tag))
const notProbedTags = rosterTags.filter((t) => !probedTags.has(t))

phase('Verdict')
const verdict = await agent(
  `Deliver the patch-smoke verdict for the promoted cc-enhanced binary.

Status phase: ${JSON.stringify(statusRes)}
Probe results: ${JSON.stringify(flatProbes)}
Not probed (probe agent failed): ${JSON.stringify(notProbedTags)}

Rules:
- pass: the signature tag set matches the roster and no probe is missing (ast-only and unknown are acceptable; list them in notes).
- stale-promote: missing probes or roster/signature mismatches that are explained by patch sources or the roster changing after the last promote (see the status concerns about recent or uncommitted src/patches changes). Set staleTags. Primary next step: re-run mise run native:update to re-promote.
- fail: a patch is missing with no stale-promote explanation (possible silent no-op). Set missingTags. Next step: run the patch-update workflow with a tag filter for the affected patch(es) and inspect.
- inconclusive: probes could not run meaningfully (unpack failed or too many not-probed units).

nextSteps: exact commands in priority order. Work only from the inputs above; do not run any commands. Do not modify any files.${focus}`,
  {
    label: 'smoke verdict',
    phase: 'Verdict',
    schema: VERDICT_SCHEMA,
  },
)

return { statusRes, unpack, probes: flatProbes, notProbedTags, verdict }
