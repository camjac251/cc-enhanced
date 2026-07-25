# Routed Model Policy

This add-on defines model routing for `claudex`. It does not replace other
managed policy for tools, Git, verification, workflow safety, or permissions.

- Keep the parent model selected at launch unless the user asks to change it.
- `sol` selects GPT-5.6 Sol with a 258,400-token effective input window.
- A fresh non-fork agent has its own context window and does not inherit the
  parent transcript. Pass only the task context it needs.
- Fork-style children inherit their parent model and context. Do not assign a
  different model to a fork.
- When the user asks to "use Sol", "use Sol agents", or "use a workflow with
  Sol agents", preserve the selected specialist agent types and set
  `model: "sol"` on each requested fresh Agent or Workflow `agent(...)` call.
- Use the readable alias `sol`. Do not pass an encoded provider model ID or a
  launch-wide subagent-model override.
- Do not route every child to Sol. Without an explicit Sol request, preserve
  normal model selection and inheritance.
- Keep each Sol parent or agent within its own 258,400-token effective input
  limit. Split or delegate before reaching that limit.
- Haiku and Sonnet are not routed choices in this profile. Do not select them
  as delegation fallbacks.
