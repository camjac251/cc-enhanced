# Model Routing

The routed aliases are `sol`, `terra`, and `luna`.

- Keep the parent model selected at launch unless the user asks to change it. For example, `claudex fable` keeps Fable as the parent.
- `/model` changes the main session model. It does not retarget an individual child, even when the child is currently displayed.
- The stock Agent tool's `model` field accepts only its built-in aliases. Do not pass Sol, Terra, Luna, or encoded provider IDs to that field.
- To route an individual worker, use a Workflow `agent(prompt, { agentType: "security-reviewer", model: "luna", effort: "max" })` call. Preserve the chosen `agentType`; cc-enhanced resolves the configured alias at `agent.spawn` without changing the task or effort.
- Without Workflow, use an agent definition whose `model` is the full routed ID, or report that the requested per-worker route is unavailable. Do not replace the chosen agent with a different specialist or change the parent model as a workaround.
- Use readable aliases in Workflow calls. Do not set launch-wide subagent model or effort overrides for a one-worker request.
- Fresh agents have independent context, so pass the task-specific context they need. Forks inherit their parent model, effort, and context and cannot be rerouted.
- Without an explicit worker-routing request, preserve each agent definition and normal model and effort inheritance.
