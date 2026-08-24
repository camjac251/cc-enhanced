# Model Routing

The routed aliases are `sol`, `terra`, and `luna`.

- Keep the parent model selected at launch unless the user asks to change it. For example, `claudex fable` keeps Fable as the parent.
- `/model` changes the main session model. It does not retarget an individual child, even when the child is currently displayed.
- When a user requests a model or effort for a fresh subagent or named teammate, preserve the exact `subagent_type` selected from the current setup and set that call's `model` and `effort`. Never replace it with a model-specific agent type.
- For example, "use my security reviewer on Luna at max" means `subagent_type: "security-reviewer"`, `model: "luna"`, and `effort: "max"` on that Agent call.
- For workflows, preserve the chosen `agentType` and route each requested worker directly, for example `agent(prompt, { agentType: "security-reviewer", model: "luna", effort: "max" })`.
- Use readable aliases. Do not pass encoded provider model IDs or set launch-wide subagent model or effort overrides for a one-worker request.
- Fresh agents have independent context, so pass the task-specific context they need. Forks inherit their parent model, effort, and context and cannot be rerouted.
- Without an explicit worker-routing request, preserve each agent definition and normal model and effort inheritance.
