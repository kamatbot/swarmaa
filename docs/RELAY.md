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

## Wire protocol (v1, binding for R1–R3)

All frames are JSON text WebSocket messages with a `t` field. Unknown fields are ignored; unknown `t` values are dropped. Frames are at most 1 MiB.

**Endpoints (Worker):**
- `GET /host/<host_id>`: WebSocket for the host agent.
- `GET /h/<host_id>`: WebSocket for clients.
- `GET /h/<host_id>/presence`: JSON `{online, last_seen, version}`.
- `GET /healthz`: `ok`.

`host_id` matches `^[a-z2-7]{26}$`.

**Host handshake:**
1. On connect the DO sends `{t:"challenge", nonce}`, where `nonce` is 32 random bytes in base64url.
2. The host replies `{t:"hello", role:"host", host_id, pubkey, sig, version}`:
   - `pubkey` is the raw 32-byte Ed25519 key in base64url;
   - `sig` is the Ed25519 signature over the UTF-8 bytes of `nonce`;
   - `host_id` must equal base32-lowercase(SHA-256(pubkey)) without padding, first 26 characters.
3. The DO pins `pubkey` on first hello. If it differs later, it closes with 4003.
4. A second host socket replaces the first, which is closed with 4009.
5. With no valid hello within 10 s, the DO closes with 4001.

**Client handshake:**
1. The client sends `{t:"hello", role:"client", version}`.
2. The DO replies `{t:"presence", online, last_seen, version}`, and sends it again whenever the host connects or disconnects.

**Requests:** the client picks `sid`, a string of up to 32 characters, unique per socket. The DO rewrites it to `"<conn>:<sid>"` toward the host, where `<conn>` is the DO's id for that client socket, and strips the prefix on the way back.
- `{t:"req", sid, method, path, headers, body}`: `body` is a UTF-8 string or null. `headers` are lower-case names, from the allowlist `authorization`, `accept`, `content-type`, `last-event-id`.
- `{t:"res", sid, status, headers}`, then zero or more `{t:"chunk", sid, data}`, then `{t:"end", sid}`. `data` is a UTF-8 string of at most 64 KiB.
- `{t:"end", sid, error}` from either side aborts a stream. If the host is offline, the DO answers a `req` at once with `{t:"end", sid, error:"host_offline"}`.
- A client closing its socket makes the DO send `{t:"end", sid:"<conn>:*", error:"client_gone"}` to the host, which aborts all of that client's streams.

**Pairing:**
1. Host → DO: `{t:"pair_open", code_hash, expires_at}`, where `code_hash` is the hex SHA-256 of the normalized code (lower case, single spaces) and `expires_at` is epoch ms. The DO stores it.
2. Client → DO: `{t:"pair_redeem", rid, code, device_name}`. The DO checks the hash and the expiry. A match is consumed (one use) and forwarded to the host as `{t:"pair_redeem", rid:"<conn>:<rid>", device_name}`. A miss gets `{t:"pair_result", rid, error:"bad_code"}`.
3. Host → DO → client: `{t:"pair_result", rid, token}` or `{t:"pair_result", rid, error}`.

**Keepalive:** either side may send `{t:"ping"}` and gets `{t:"pong"}`. The host agent pings every 25 s.

**Limits (DO):**
- 32 client sockets per room;
- 64 open streams per client;
- 5 `pair_redeem` per room per 10 minutes;
- 120 `req` per client per minute.

Over a limit, the DO answers `{t:"end", sid, error:"rate_limited"}` or closes with 4029.
