# Relay and signalling (Cloudflare)

Status: design, not built. Owner: coordinator. Date: 2026-10-28.

## Goal

A Mac runs Swarmaa as a **host**: the service, Postgres and the worker bridges, as today on the Mac Studio. Other Swarmaa apps (Mac now, iOS later) **operate** that host from anywhere: read bots, threads and tasks, post messages, answer questions, and watch the live stream.

## What exists today

- The Mac Studio's service listens on `127.0.0.1:8787`.
- A named Cloudflare Tunnel (`com.swarma.tunnel`, `.local/cloudflared.yml`) publishes it as `https://api.swarmaa.com`.
- Clients authenticate with a bearer connection token (REST `/api/tools/*`, SSE `/api/stream`) or with OAuth at `/mcp`.

That already reaches this one host from anywhere. It does not scale to other hosts: every host would need its own Cloudflare account, domain and `cloudflared`. There is also no way to find a host, see whether it is online, or pair a new device without copying a token by hand.

## Design

One Cloudflare Worker at `relay.swarmaa.com`, with a Durable Object per host.

```
 iPhone / other Mac ──wss──►  Worker  ──►  HostRoom DO (host:<host_id>)  ◄──wss── relay agent on the host Mac ──http──► 127.0.0.1:8787
                              (routing,       (presence, pairing codes,
                               rate limits)    frame relay, push wake)
```

- **The host dials out.** A small relay agent, `src/relay-agent.ts` (launchd `com.swarma.relay`), keeps one outbound WebSocket to its `HostRoom`. No inbound port, no tunnel and no domain per host.
- **Clients dial the room.** `wss://relay.swarmaa.com/h/<host_id>`. The DO pairs each client socket with a stream id and forwards frames to the host socket. The agent replays each frame as a local HTTP request to the service and streams the response back, SSE included.
- **The service is unchanged.** It still sees normal REST and SSE requests with bearer tokens, from loopback. All authorization stays in `CoreService`. The relay grants nothing.
- **Transport security in v1:** TLS from each end to Cloudflare, plus the service's bearer token on every request. This is the same exposure as the current `api.swarmaa.com` tunnel, where Cloudflare also terminates TLS.
- **Signalling.** The DO also holds:
  - **Presence:** whether the host is online, last seen, and agent version. The app shows "Mac Studio · online".
  - **Pairing:** the owner runs Pair a device on the host (`npm run relay:pair`, later a button). It prints a six-word code, valid for five minutes and good for one use. A new device redeems it at the DO. The DO forwards the redemption to the host agent, which mints a frontend connection token for that device and returns it.
  - **Wake and notify:** when a bot needs you, the host posts a content-free "needs you" ping to the DO. For iOS, the DO sends an APNs push, later.
- **Hostinger, R2, D1:** not needed. Durable Object storage holds the host's public key, its paired-device list (public keys only), and pending pairing codes.

### Not in v1

- **End-to-end encryption** (Noise `XX` between the client and the host agent, so Cloudflare sees only ciphertext). This is the first v2 item, needed before hosts belong to people other than the relay's owner.
- **WebRTC peer-to-peer** (DO as signalling, Cloudflare TURN as fallback). Relay latency is fine for chat and task cards. Add P2P only if large diffs or artifacts make relay bandwidth a problem.
- **Multi-host switching in the app UI.** v1 has one host per app. The protocol already keys everything by `host_id`.

## Frames

JSON text frames over the WebSocket, one request per stream id. The DO forwards them unchanged:

| Frame | Direction | Fields |
|---|---|---|
| `req` | client → host | `sid`, `method`, `path` (allowlist: `/api/tools/*`, `/api/stream`, `/api/inbox/wait`, `/healthz`), `headers` (Authorization, Accept, Content-Type, Last-Event-ID), `body` (≤ 512 KiB) |
| `res` | host → client | `sid`, `status`, `headers` |
| `chunk` | host → client | `sid`, `data` (≤ 64 KiB; SSE streams as many chunks) |
| `end` | either | `sid`, optional `error` |

Control frames to the DO: `hello` (role, host_id, version), `presence`, `pair_open` (host → DO: code hash and expiry), `pair_redeem` (client → DO → host: code and device name), `pair_result` (host → DO → client: token or error), and `ping`.

## Security

- **Host identity:** an Ed25519 key is created on first run and kept in `.local/relay-host.key` with mode 0600. `host_id` is the base32 SHA-256 of the public key, truncated to 26 characters. The host proves possession by signing the DO's nonce in `hello`. The DO pins the first key per `host_id`, so nobody else can register that room.
- **Clients:** any client may open a socket to a room. Every relayed request still needs a valid bearer token, which the service checks. A bad token gets the same 401 as through the tunnel today. The DO rate-limits sockets per IP and per room. `pair_redeem` is limited to 5 tries per room per 10 minutes.
- **Revoking a device:** revoke its connection token in the service, as today.
- **Limits:** the existing body, response and rate limits stay in the service. The DO adds per-socket frame and byte limits.

## Build plan

| Part | Owner | Files | Acceptance |
|---|---|---|---|
| R1 Worker and HostRoom DO | Antigravity | `relay/` (wrangler project): routing, presence, pairing codes, frame relay, limits | `vitest` with Miniflare: a host and two clients, relay a request and an SSE stream, unpaired socket refused, pairing code expiry |
| R2 Host relay agent | Codex | `src/relay-agent.ts`, `scripts/relay-pair.ts`, launchd plist in `scripts/deploy-local.ts` | Node tests with a fake relay socket: replays requests to a fake service, path allowlist, SSE chunking, reconnect with backoff, signed hello, pairing mints a token |
| R3 Swift client transport | Antigravity | `Mac-app/Sources/Providers/SwarmaRelayTransport.swift`, onboarding "Connect to a host" | XCTest with a fake WebSocket: frame codec, request/response, SSE over relay, pairing redeem |
| R4 Wiring and docs | coordinator | `SwarmaTeamsClient` picks direct or relay, TRANSPORT.md, OPERATIONS.md | End to end from this Mac through `relay.swarmaa.com` to the Mac Studio |

R1, R2 and R3 touch different files and share only this document's frame table, so they run in parallel.

## Needs from the owner

- `wrangler login` (or a Workers-scoped API token in `.env` as `CLOUDFLARE_API_TOKEN`) for the account that owns `swarmaa.com`.
- Confirm `relay.swarmaa.com` as the hostname.
