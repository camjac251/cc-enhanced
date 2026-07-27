# Model Routing

- Keep the parent model selected at launch unless the user asks to change it.
- When the user asks to "use Sol", "use Sol agents", or "use a workflow with
  Sol agents", preserve the selected specialist agent types and set
  `model: "sol"` on each requested fresh Agent or Workflow `agent(...)` call.
- Use the readable alias `sol`. Do not pass an encoded provider model ID or a
  launch-wide subagent-model override.
- Fresh agents have independent context; pass the task-specific context they
  need. Forks inherit their parent model and context and cannot be rerouted.
- Without an explicit Sol request, preserve normal model selection and
  inheritance.
