export const meta = {
  name: 'prompt-drift-review',
  description: 'Review prompt-surface drift evidence before fixing patches or refreshing baselines',
  whenToUse: 'Use in cc-enhanced when prompt drift, prompt exports, dash style, or policy-surface changes need manual review.',
  phases: [
    { title: 'Scope', detail: 'find prompt exports, baseline, and verifier evidence' },
    { title: 'Review', detail: 'inspect watched surfaces, policy, and compare output' },
    { title: 'Synthesize', detail: 'classify drift and recommend the next action' },
  ],
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['area', 'status', 'evidence', 'findings'],
  properties: {
    area: { type: 'string' },
    status: { enum: ['pass', 'drift', 'blocked'] },
    evidence: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description', 'evidence', 'recommendation'],
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          description: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['classification', 'summary', 'sourceFixes', 'baselineDecision', 'verificationNeeded'],
  properties: {
    classification: { enum: ['no-drift', 'intended-drift', 'unintended-drift', 'blocked'] },
    summary: { type: 'string' },
    sourceFixes: { type: 'array', items: { type: 'string' } },
    baselineDecision: { type: 'string' },
    verificationNeeded: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const focus = typeof args === 'string' && args.trim()
  ? `\nUser focus: ${args.trim()}`
  : ''

phase('Scope')
const scope = await agent(
  `Inspect the cc-enhanced checkout for prompt-surface rules, the prompt drift baseline, exported prompt artifacts, compare reports, and recent verification evidence. Do not refresh baselines, edit files, commit, or push. Cite command output or file:line evidence.${focus}`,
  {
    label: 'prompt scope',
    phase: 'Scope',
    schema: {
      type: 'object',
      required: ['baseline', 'surfaceRules', 'exports', 'compareReports', 'verificationEvidence', 'gaps'],
      properties: {
        baseline: { type: 'string' },
        surfaceRules: { type: 'string' },
        exports: { type: 'array', items: { type: 'string' } },
        compareReports: { type: 'array', items: { type: 'string' } },
        verificationEvidence: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

phase('Review')
const reviews = await parallel([
  () => agent(
    `Review watched prompt surfaces against available drift evidence. Distinguish prompt-surface validity from watched-hash drift. If exports or command outputs are missing, say exactly what is missing.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'watched surfaces',
      phase: 'Review',
      schema: REVIEW_SCHEMA,
    },
  ),
  () => agent(
    `Review policy and wording quality for required/forbidden needles, dash style, exact-line overlap with managed policy files, and accidental weakening. Cite concrete paths and line evidence.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'policy wording',
      phase: 'Review',
      schema: REVIEW_SCHEMA,
    },
  ),
  () => agent(
    `Review whether any baseline refresh would be justified. A refresh is justified only after the patched export is manually reviewed as known-good. Prefer source fixes for unintended drift.\n\nScope:\n${JSON.stringify(scope)}${focus}`,
    {
      label: 'baseline decision',
      phase: 'Review',
      schema: REVIEW_SCHEMA,
    },
  ),
])

phase('Synthesize')
const summary = await agent(
  `Classify prompt drift from the reviews. Do not say drift is corrected unless a source fix or reviewed baseline refresh is supported by current evidence.\n\nScope:\n${JSON.stringify(scope)}\n\nReviews:\n${JSON.stringify(reviews)}`,
  {
    label: 'prompt drift synthesis',
    phase: 'Synthesize',
    schema: SUMMARY_SCHEMA,
  },
)

return { scope, reviews, summary }
