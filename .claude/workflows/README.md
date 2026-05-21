# cc-enhanced Workflows

Repo-local workflows are for patch and prompt release work in this checkout.
They complement the local slash skills and do not run native update, commit, or
push by themselves.

Workflow summary:

- `patch-release-audit`: final readiness audit after patch, docs, or release
  changes.
- `patch-drift-triage`: first-pass release drift review before changing patch
  anchors.
- `prompt-drift-review`: manual review of prompt drift, prompt exports, dash
  style, and baseline decisions.

Suggested release loop:

1. Use `patch-drift-triage` when a new release appears.
2. Patch the latest bundle and run the required verifier commands.
3. Use `prompt-drift-review` if prompt-surface or watched-hash drift appears.
4. Use `patch-release-audit` before committing or pushing.
