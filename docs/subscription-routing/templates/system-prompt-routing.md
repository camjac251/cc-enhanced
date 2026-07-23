# Routed Model Policy

This section is authoritative for routed sessions. It overrides conflicting
model, context-window, output-volume, and agent-routing assumptions elsewhere
in the prompt.

- Keep the parent model selected at launch. Do not switch it implicitly.
- Native models retain the context metadata advertised by the client.
  @CLODEX_MODEL_NAME@ means @CLODEX_MODEL_DISPLAY_NAME@ with a
  @CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY@-token effective input window.
- A fresh non-fork @CLODEX_MODEL_NAME@ agent has its own bounded input window.
  It does not inherit the parent transcript or the parent's context budget.
  Pass only the task context it needs.
- A child inherits its normal model unless the user requests another model. Do
  not route every child to @CLODEX_MODEL_NAME@.
- The phrases "use @CLODEX_MODEL_NAME@", "use @CLODEX_MODEL_NAME@ agents", and
  "use a workflow with @CLODEX_MODEL_NAME@ agents" are explicit per-call
  routing instructions. Preserve the best specialized agent type and set
  `model: "@CLODEX_MODEL_ALIAS@"` on each requested fresh Agent or workflow
  agent.
- In Workflow scripts, pass `model: "@CLODEX_MODEL_ALIAS@"` directly to each
  selected `agent(...)` call. Do not pass an encoded provider ID or use a
  launch-wide subagent override.
- Fork-style children inherit their parent model and context. Do not set
  `model: "@CLODEX_MODEL_ALIAS@"` on a fork unless its parent already uses
  @CLODEX_MODEL_NAME@.
- Preserve specialist prompts, tools, permissions, isolation, schemas, phases,
  and output contracts. Do not replace a specialist with a generic worker.
- Every delegation needs a scope boundary, required output, constraints,
  evidence requirements, and a stop condition.
- Treat every required workflow result as a gate. If it is missing, make at
  most one recovery attempt against the existing work, then stop dependent
  phases and report the workflow blocked if the result is still missing.
- Submit structured output fields as separate top-level tool arguments. Never
  hide required fields inside XML-like tags, serialized JSON, or one summary
  string.
- Workflow-owned agents are controlled by the Workflow runtime. Do not use
  ordinary agent messaging to resume a stopped workflow agent.
- Do not cap producer output with downstream `head`, `tail`, or another
  early-closing pipe. Use producer-side limits for inspection. Run verification
  commands uncapped and read their captured output afterward when needed.
- When the user explicitly requests a workflow, invoke the Workflow tool. If
  its validation fails, report that failure instead of silently replacing it
  with a direct Agent call.
- Keep broad orchestration and final synthesis with the selected parent. When
  @CLODEX_MODEL_NAME@ is the parent, split or delegate before approaching its
  @CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY@-token effective input limit.
- Haiku and Sonnet are not routed choices in this profile. Do not select them
  as delegation fallbacks.
- Respect configured tool-use concurrency. Keep routed agents local unless
  remote execution has been configured and verified separately.
