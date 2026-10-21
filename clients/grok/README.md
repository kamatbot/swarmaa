# Grok Bot entrypoint

## Native Grok Bot connection

Use Grok Bot's custom MCP **Remote HTTPS** connection as the primary integration. The official
[Team Bots guide](https://docs.x.ai/grok-bot/team-bots) documents remote MCP with either a
Bot credential or each person's OAuth sign-in.

1. Reuse the `frontend` principal named `grok` provisioned by the repository README, with the
   same exact project scopes as Dot. Create it only if it does not already exist.
2. In the Bot's plugin/MCP setup, add a custom Remote HTTPS server using
   `https://collective.example.com/mcp`, replacing the domain with your deployed service.
3. For OAuth, complete the service consent flow using that principal's provisioned non-admin
   token. Configure the exact client callback hostname as described in `docs/OPERATIONS.md`.
   If you deliberately choose the Bot's shared token connection instead, store its credential
   in the app's secret/authentication mechanism, not in chat or command arguments.
4. Confirm tool discovery and `context_get({"scope":"project:demo"})`. Then retrieve a task
   created through Dot by its task ID. Record the app version and actual observed result before
   describing the connection as active.

A shared Bot credential grants its scopes to conversations that use that connection. Choose
identities and audiences deliberately. The package does not connect an account automatically,
and Grok's private/team memory remains separate from records explicitly published to this service.

Use `clients/NETWORK_RULES.md` for the Bot's instructions. Delegate with `claude.read` or
`codex.read`, retain task IDs, and use `task_get`/`artifact_get` for results. Start list calls with
small pages and follow returned task-list cursors. Request memory revision bodies only when
needed, using small `history_limit` and `proposal_limit` values. The `*_has_more` flags mean older
records were omitted; memory history pagination is not implemented in this release.

Use `events_poll` for portable updates. Optional webhook/routine wake-up requires your actual
receiver URL, authentication and payload contract; see `docs/OPERATIONS.md` before registering
a sink. No routine or outbound message is enabled by this configuration alone.

## Optional custom Grok backend

If you operate your own bot backend, `rest-client.mjs` forwards authorized frontend tools through
the REST API. It is an alternative integration component, not a requirement for native Grok Bot.
Set these variables privately in that backend:

- `COLLECTIVE_URL`: the HTTPS service origin, such as `https://collective.example.com`, without `/mcp`.
- `COLLECTIVE_GROK_TOKEN`: the provisioned token for that backend's scoped frontend principal.

OAuth-issued access tokens cannot authenticate these REST routes. Keep the provisioned token
out of system prompts, browser JavaScript and source control. If the native Bot and custom backend
are both used, provision separate identities so they can be revoked independently.

```js
import { callCollective } from './rest-client.mjs';
const result = await callCollective('context_get', {scope: 'project:demo'});
```

Send the returned data to the model as tool output. The wrapper permits frontend operations;
memory promotion/retraction and worker lease operations are excluded. The service independently
enforces every grant. It rejects responses over 8 MiB, so request small collection pages.

Your backend still supplies its own model credentials, chat-channel integration and deployment.
The wrapper does not call the xAI model API or send unsolicited messages.
