## Agent-cost policy

  - Default to no subagents.
  - If delegation is explicitly required, use at most one subagent at a time.
  - Use `gpt-5.6-luna` with low reasoning effort.
  - Never use Astra/high reasoning unless I explicitly request it.
  - Prefer inline implementation and review for small tasks.
  - Do not dispatch a new reviewer when existing tests and a focused diff review are sufficient.
  - Keep delegated tasks bounded and report within 5 minutes when possible.