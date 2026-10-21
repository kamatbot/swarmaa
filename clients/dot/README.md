# Dot entrypoint

Create a distinct `frontend` principal, for example `dot`, with `project:demo` access.
Use your deployed `https://collective.example.com/mcp` endpoint in Dot's custom MCP connection
flow. Complete the service OAuth consent using the token provisioned for that principal.
The exact Dot UI and event callback integration are covered by the service's MCP/event guide.

Use `clients/NETWORK_RULES.md` as your instruction starting point. Confirm `tools/list` and
`context_get({"scope":"project:demo"})` before saying that the connection is active.

A first read-only dispatch can call `task_submit` with:

```json
{
  "scope": "project:demo",
  "kind": "review",
  "objective": "Review the authentication flow and report concrete defects with file references.",
  "required_capability": "claude.read",
  "idempotency_key": "dot-auth-review-001",
  "constraints": ["Read only", "Do not install packages or call external services"],
  "acceptance_criteria": ["Each finding includes evidence and a suggested fix"]
}
```

Save the returned task ID. Grok Bot can retrieve the same task using its own scoped connection.
If push events are unavailable, poll `events_poll`, advance `next_cursor` only after handling
the received events, and fetch the changed task. The service does not manufacture a Dot account
connection or a hosted callback URL for you.
