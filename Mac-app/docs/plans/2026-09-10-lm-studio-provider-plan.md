# LM Studio monitoring plan

Prepared 2026-09-10 against `0a6c6fb` (Codenotch 1.7.0), as the
"LM Studio can follow through the same display model" increment reserved in
[the local LLM plan](2026-09-07-local-llm-provider-plan.md), section 5.
Status: implemented in one increment, as the user asked. Verification is
recorded at the end.

## What the user chose

Asked after the reconnaissance below, the user decided:

1. Everything in one increment: inventory, busy/idle, tokens and speed.
2. Statistics come from LM Studio's server log; reading those files is accepted.
3. A token is optional. Without one nothing is added to request headers. The
   token requirement on this Mac could be switched off briefly to test the
   no-token path.
4. The cell's headline is the last response's tok/s, as with Ollama; tokens
   for today live in the tooltip.
5. The ring's arc is how full the context was on the last request.
6. All existing log files are read at start, not only new lines.
7. A queue behind the running request is a separate visual state.
8. Embedding models are not shown.
9. The glyph comes from Lobe Icons, which does carry an LM Studio mark.
10. Only the current `/api/v1` REST API is supported.

From the proposed extensions: the daily token ledger per model, the reasoning
share and the speculative-decoding acceptance rate.

## What LM Studio exposes (reconnaissance, 0.4.24, 2026-09-10)

| Source | What it gives | Auth | Used for |
| --- | --- | --- | --- |
| `GET /api/v1/models` | every model, `loaded_instances` with each instance's `config.context_length`, `size_bytes`, `quantization.name`, `type` (`llm` / `embedding`) | Bearer token when the server requires one | inventory, one cell per loaded language-model instance |
| SDK WebSocket on the same port, `ws://127.0.0.1:1234/llm` | `listLoaded` → `instanceReference`, `ttlMs`, `lastUsedTime`; `getInstanceProcessingState` → `status` ∈ `idle`, `processingPrompt`, `generating`, `computingEmbedding` and `queued` | the same token, sent as `clientIdentifier:clientPasskey`; with the requirement off, any pair | what each instance is doing, queue depth, the generating clock |
| `~/.lmstudio/server-logs/YYYY-MM/YYYY-MM-DD.N.log` | per request: `Running chat completion…`, `Prompt processing progress`, `Generated prediction: {…}` with `usage` and `stats` | none | tokens per model per day, reasoning share, draft acceptance, tok/s where the runtime clocked it, context fill |
| `~/.lmstudio/.internal/http-server-config.json` | the configured port | none | the default address |
| `/lmstudio-greeting` | `{"lmstudio":true}` without a token | none | a fingerprint, not used yet |

Findings that shaped the design:

- Unknown paths under `/v1` and `/api/v0` answer HTTP 200 with an error body,
  so the parser fails on the envelope, never on the status code.
- API tokens are `sk-lm-<8>:<20>`; the regex is baked into the `lms` binary.
  The permission store keeps only SHA-512 hashes, so there is nothing on disk
  to borrow. The user pastes the token into Settings; it lives in the login
  keychain under `lmstudio-api-token`, and `LM_API_TOKEN` wins over it.
- `diagnostics.streamLogs` (what `lms log stream` uses) is refused for API
  tokens: they carry only the `dynamicRemoteMcpServer` and `pluginUse`
  permissions. The server log on disk is the only passive per-request source.
- The OpenAI-compatible endpoint logs `usage` (counts, draft statistics) but no
  clock; `/api/v0` and `/api/v1` log `tokens_per_second`. Most clients use the
  OpenAI endpoint, so speed there is timed from the `generating` phase as
  polled, against the log's token count, and marked `~`.
- With `tokenMode` switched to `disabled` in the permission store, LM Studio
  reloaded it live: REST answered without a token and the socket accepted a
  random identifier and passkey. The store was restored byte-for-byte.
- Log lines are stamped in the Mac's own zone without an offset; prompts and
  replies are in the file whenever "log sensitive data" is on. The scanner
  keeps only the two top-level numeric blocks, by their two-space indentation.
- The log is large and mostly the server noting API calls: 520 MB and fifteen
  million lines across 136 files on this Mac, for about 1,700 responses. The
  first parser dated every line with a `DateFormatter` and never finished;
  the one that shipped works on bytes, rejects a line on the first byte of
  its message, and reads files in 4 MB slices.
- LM Studio logs every `listLoaded` call and every REST listing at INFO, but
  not `getInstanceProcessingState`. Polled naively that was 210 lines a
  minute from Codenotch alone. The listing (REST and socket) is now asked
  every five seconds and answered from memory in between; only the unlogged
  state call runs at 0.4 s.

## Design

Provider id `lmstudio` (a persistence key; do not rename). Cells are
`lmstudio:model:<instance id>`, because the instance id is what a client passes
as `model`, the tag in the server log, and the handle the socket reports on.

- `LMStudioLocalProvider` + `LMStudioUsage`: `GET /api/v1/models` on the
  configured loopback address, answered from memory for five seconds because
  the store asks every second and LM Studio logs each answer; the bearer
  header only when a token exists;
  401/403 → `LMStudioError.needsToken`, shown in Settings, never as a sign-out.
  `size_bytes` is labelled "Model size" (`LocalRuntimeReading.Model.memoryKind`),
  not memory. `modelKey` keeps the brand mark when an instance has a custom id.
- `LMStudioLink` + `LMStudioWire`: the SDK socket as a small JSON-RPC client
  over `URLSessionWebSocketTask`, one call at a time, reopened after failure.
  `parameter` is omitted when an endpoint takes none — `{}` is a type error.
- `LMStudioMetrics`: polls `getInstanceProcessingState` every 0.4 s against a
  `listLoaded` answer refreshed every 5 s, publishes `LocalModelActivity`
  (phase, queue, since) per cell,
  clocks the `generating` phase, tails the server log (full history first,
  then the newest file every second) into `LocalTokenLedger`, and derives
  `LocalModelPerformance` — exact from the runtime's own rate or time,
  approximate from the clocked phase, only for a response that just ended.
  Backs off two seconds when the server is down. A stored-token change drops
  the socket so the next poll authenticates afresh.
- Notch: `ProviderRing` draws a local cell's arc as the context fill (a full
  ring when unknown, as before for Ollama) in the speed band colour, grey
  before any speed exists. The inner activity arc becomes a turning ring of
  dots when `ActivitySummary.queued > 0`. `NotchViewModel` keeps performances
  per source so the Ollama relay switch clears only its own; ledger summaries
  are read against `now`, so "today" rolls over without a new log line.
- Tooltip: five more rows for a logged runtime — context used, tokens today,
  requests today, reasoning share, draft accepted — counted in
  `ProviderSnapshot.localLedgerRowCount` and budgeted in `NotchLayout.cardHeight`.
  The header note names the phase and the queue.
- Settings → LM Studio: monitoring switch, address (default from LM Studio's
  own config), token field with Save/Remove, socket status, today's totals,
  and a plain statement of what is read from where. Accounts rows say which
  runtime a model is loaded in (`ProviderSummary.runtimeName`).
- `UsageStore.isBusy` includes a generating or prompt-reading LM Studio model,
  so cloud polling speeds up for local work too.
- The menu bar's menu, which had only ever known quota providers, lists a
  local runtime as "LM Studio — 2 models loaded" with one line per model —
  headline, phase and queue, context fill, tokens today — read from a
  panel-less `NotchViewModel` the fleet feeds alongside the displays'
  (`NotchFleet.menuModel`), so the menu and the cells cannot disagree. This
  fixed the same gap for Ollama.

Not done, deliberately: TTL / unload time (the REST listing has none; the
socket's `ttlMs` could feed it later), per-client attribution (the log names
the model, not the caller), a relay (not needed), legacy `/api/v0` inventory.

## Verification

Recorded payloads from this Mac are quoted in `LMStudioUsage`,
`LMStudioServerLog` and the test fixtures. The log fixtures carry marker text
in the reply fields so `testNothingOfTheReplyOrPromptSurvivesParsing` can
prove the parser drops them.

The full suite (`make test`) ran 1084 tests: 1082 passed, 2 opt-in live
checks skipped, 0 failures. The first run found three assertions that spelt
"17.9" with a point on a Mac whose locale writes "17,9"; they now build the
expectation the way the label is built, as the Ollama tests do.

`LMStudioViewTests` rendered the notch and the card on all four edges at all
three sizes with a ledger, a queued instance and a context arc
(`TEST_RUNNER_LMSTUDIO_RENDER_DIRECTORY`); the right-edge medium frames were
inspected: a grey full ring for a model without a speed, a green 61 % arc with
the turning ring of dots for a queued one, and the five ledger rows under the
speed pair. The header note had been pushing the title to "Qwen · Lo…"; the
title now takes layout priority and the note is the short form ("Prompt · 1
queued").

The opt-in live check (`TEST_RUNNER_CODENOTCH_LMSTUDIO_LIVE=1`, with
`TEST_RUNNER_LM_API_TOKEN` because this server requires one) confirmed the
socket and the REST listing name the same instances and timed the history
read: 1,665 logged responses from 17,509 events in 10.3 s over 520 MB.

The Debug app was then launched with `LM_API_TOKEN` in its environment
(the token cannot be typed into Settings from a script) and watched through
`log stream`: "Connected · 1 loaded"; history read in 12.7 s and five
instances given their last logged speed; an OpenAI-endpoint request went
`processingPrompt` → `generating` → idle and was timed at ~19.9 tok/s from
120 tokens; a `/api/v0` request was read at the runtime's own 34.3 tok/s.
The timed figure reads lower than LM Studio's own for the same model, since
the generating phase includes the runtime's bookkeeping before it reports
idle and the poll's 0.4 s resolution; it is marked `~` for that reason. In
the same eighteen seconds LM Studio's log gained 4 `listLoaded` and 3 REST
listing lines from Codenotch, against 210 a minute before the caching.

Not exercised live: a second instance queued behind the first (rendered from
a fixture only), a server with the token requirement off in the running app
(covered by the earlier store-file experiment and the wire tests), and a
midnight rollover (covered by `testTheRingIsTheContextAndTheTooltipGetsTheLedger`).
