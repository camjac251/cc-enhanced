export const meta = {
  name: 'patch-release-audit',
  description: 'Audit cc-enhanced patch, release, and prompt drift readiness before commit or push',
  whenToUse: 'Use in cc-enhanced after upstream releases, patch changes, prompt drift fixes, or docs/count updates.',
  phases: [
    { title: 'Inspect', detail: 'inspect source, docs, and runtime state' },
    { title: 'Cross-check', detail: 'compare findings and look for gaps' },
    { title: 'Synthesize', detail: 'return push readiness summary' },
  ],
}

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['area', 'status', 'evidence', 'issues'],
  properties: {
    area: { type: 'string' },
    status: { enum: ['pass', 'issues', 'blocked'] },
    evidence: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description', 'evidence'],
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          description: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['ready', 'summary', 'mustFix', 'verification'],
  properties: {
    ready: { type: 'boolean' },
    summary: { type: 'string' },
    mustFix: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    pushNotes: { type: 'array', items: { type: 'string' } },
  },
}

const focus = typeof args === 'string' && args.trim()
  ? `\nUser focus: ${args.trim()}`
  : ''

phase('Inspect')
const audits = await parallel([
  () => agent(
    `Inspect cc-enhanced patch source changes. Confirm new patches are registered in src/patches/index.ts and src/patch-metadata.ts, have co-located tests, and avoid hardcoded minified names. Cite file:line evidence.${focus}`,
    {
      label: 'patch source audit',
      phase: 'Inspect',
      schema: AUDIT_SCHEMA,
    },
  ),
  () => agent(
    `Inspect docs and project instructions for patch count, runtime env vars, removed stale references, and README accuracy. Cite file:line evidence.${focus}`,
    {
      label: 'docs audit',
      phase: 'Inspect',
      schema: AUDIT_SCHEMA,
    },
  ),
  () => agent(
    `Inspect verification evidence available in the repository and current shell state. Do not run heavy native update unless explicitly asked by the user. Identify the light and heavy commands needed before push. Cite command output or file evidence.${focus}`,
    {
      label: 'verification audit',
      phase: 'Inspect',
      schema: AUDIT_SCHEMA,
    },
  ),
])

phase('Cross-check')
const challenged = await parallel(
  audits.filter(Boolean).map((audit) => () => agent(
    `Challenge this audit result. Look for unsupported claims, missing files, stale patch counts, and verification gaps. Return only issues that are supported by evidence.\n\nAudit:\n${JSON.stringify(audit)}`,
    {
      label: `challenge ${audit.area}`,
      phase: 'Cross-check',
      schema: AUDIT_SCHEMA,
    },
  )),
)

phase('Synthesize')
const summary = await agent(
  `Synthesize push readiness for cc-enhanced from these audits and challenges.\n\nAudits:\n${JSON.stringify(audits)}\n\nChallenges:\n${JSON.stringify(challenged)}`,
  {
    label: 'release readiness',
    phase: 'Synthesize',
    schema: SUMMARY_SCHEMA,
  },
)

return { audits, challenged, summary }
