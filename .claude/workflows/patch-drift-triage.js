export const meta = {
  name: 'patch-drift-triage',
  description: 'Triage upstream release drift before changing cc-enhanced patches',
  whenToUse: 'Use in cc-enhanced when a new upstream release appears and you need to know what changed before patching.',
  phases: [
    { title: 'Scope', detail: 'identify versions, clean bundles, and available evidence' },
    { title: 'Review', detail: 'inspect release surfaces and patch-risk areas' },
    { title: 'Synthesize', detail: 'return a prioritized drift triage plan' },
  ],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['area', 'status', 'evidence', 'risks', 'commands'],
  properties: {
    area: { type: 'string' },
    status: { enum: ['clear', 'changed', 'blocked'] },
    evidence: { type: 'array', items: { type: 'string' } },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description', 'evidence'],
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          description: { type: 'string' },
          evidence: { type: 'string' },
          nextCheck: { type: 'string' },
        },
      },
    },
    commands: { type: 'array', items: { type: 'string' } },
  },
}

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'mustInspect', 'safeToPatch', 'recommendedCommands'],
  properties: {
    status: { enum: ['ready-to-patch', 'needs-inspection', 'blocked'] },
    summary: { type: 'string' },
    mustInspect: { type: 'array', items: { type: 'string' } },
    safeToPatch: { type: 'boolean' },
    recommendedCommands: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const focus = typeof args === 'string' && args.trim()
  ? `\nUser focus: ${args.trim()}`
  : ''

phase('Scope')
const scope = await agent(
  `Inspect the cc-enhanced checkout for current branch state, available clean bundles under versions_clean, current README target version, current runtime version evidence, and any existing drift reports. Do not run native update, fetch, promote, commit, or push. Cite command output or file:line evidence.${focus}`,
  {
    label: 'release scope',
    phase: 'Scope',
    schema: {
      type: 'object',
      required: ['branchState', 'knownVersions', 'currentTarget', 'availableEvidence', 'gaps'],
      properties: {
        branchState: { type: 'string' },
        knownVersions: { type: 'array', items: { type: 'string' } },
        currentTarget: { type: 'string' },
        availableEvidence: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

phase('Review')
const reviews = await parallel([
  () => agent(
    `Review upstream-to-upstream drift evidence for commands, env vars, settings, tools, agents, skills, workflows, and public prompt-like surfaces. Prefer existing diff output or clean bundle evidence. If evidence is missing, recommend exact focused commands instead of guessing.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'surface drift',
      phase: 'Review',
      schema: TRIAGE_SCHEMA,
    },
  ),
  () => agent(
    `Review local patch risk for the new release. Inspect patch anchors, verifiers, metadata registration, and known fragile surfaces. Do not run the patcher. Cite patch files or verifier evidence.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'patch risk',
      phase: 'Review',
      schema: TRIAGE_SCHEMA,
    },
  ),
  () => agent(
    `Review release workflow readiness. Identify which commands should run before editing patches, which commands are heavy, and which prompt-drift checks need exported artifacts. Keep commands repo-specific and safe.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'workflow readiness',
      phase: 'Review',
      schema: TRIAGE_SCHEMA,
    },
  ),
])

phase('Synthesize')
const summary = await agent(
  `Synthesize a prioritized patch drift triage plan. Separate confirmed drift from missing evidence. Do not claim a patch is fixed or safe unless current evidence supports it.\n\nScope:\n${JSON.stringify(scope)}\n\nReviews:\n${JSON.stringify(reviews)}`,
  {
    label: 'drift synthesis',
    phase: 'Synthesize',
    schema: SUMMARY_SCHEMA,
  },
)

return { scope, reviews, summary }
