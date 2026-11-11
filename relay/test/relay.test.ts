import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { computeHostId, bytesToBase64Url } from "../src/room";

interface HelperHost {
  ws: WebSocket;
  keyPair: CryptoKeyPair;
  rawPubkey: Uint8Array;
  hostId: string;
  messages: any[];
  waitForMessage: (pred: (m: any) => boolean, timeout?: number) => Promise<any>;
}

interface HelperClient {
  ws: WebSocket;
  messages: any[];
  waitForMessage: (pred: (m: any) => boolean, timeout?: number) => Promise<any>;
}

async function createKeyPair(): Promise<{ keyPair: CryptoKeyPair; rawPubkey: Uint8Array; hostId: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPubkey = new Uint8Array((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer);
  const hostId = await computeHostId(rawPubkey);
  return { keyPair, rawPubkey, hostId };
}

function attachMessageCollector(ws: WebSocket): {
  messages: any[];
  waitForMessage: (pred: (m: any) => boolean, timeout?: number) => Promise<any>;
  waitForClose: (timeout?: number) => Promise<{ code: number; reason: string }>;
} {
  const messages: any[] = [];
  ws.addEventListener("message", (ev: any) => {
    try {
      messages.push(JSON.parse(ev.data as string));
    } catch {}
  });

  const waitForMessage = (pred: (m: any) => boolean, timeout = 2000): Promise<any> => {
    const found = messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeout);
      const interval = setInterval(() => {
        const m = messages.find(pred);
        if (m) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(m);
        }
      }, 5);
    });
  };

  const waitForClose = (timeout = 2000): Promise<{ code: number; reason: string }> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeout);
      ws.addEventListener("close", (ev: any) => {
        clearTimeout(timer);
        resolve({ code: ev.code, reason: ev.reason });
      });
    });
  };

  return { messages, waitForMessage, waitForClose };
}

async function connectHost(
  hostId: string,
  keyPair: CryptoKeyPair,
  rawPubkey: Uint8Array,
  version = "1.0.0"
): Promise<HelperHost> {
  const res = await SELF.fetch(`http://example.com/host/${hostId}`, {
    headers: { Upgrade: "websocket" }
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`Failed to connect host: status ${res.status}`);
  }
  const ws = res.webSocket;
  ws.accept();

  const collector = attachMessageCollector(ws);
  const challenge = await collector.waitForMessage((m) => m.t === "challenge");
  const nonce = challenge.nonce;

  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(nonce))
  );

  ws.send(JSON.stringify({
    t: "hello",
    role: "host",
    host_id: hostId,
    pubkey: bytesToBase64Url(rawPubkey),
    sig: bytesToBase64Url(sig),
    version
  }));

  // Small delay to ensure host hello is processed
  await new Promise((r) => setTimeout(r, 20));

  return {
    ws,
    keyPair,
    rawPubkey,
    hostId,
    messages: collector.messages,
    waitForMessage: collector.waitForMessage
  };
}

async function connectClient(hostId: string, version = "1.0.0"): Promise<HelperClient> {
  const res = await SELF.fetch(`http://example.com/h/${hostId}`, {
    headers: { Upgrade: "websocket" }
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`Failed to connect client: status ${res.status}`);
  }
  const ws = res.webSocket;
  ws.accept();

  const collector = attachMessageCollector(ws);
  ws.send(JSON.stringify({ t: "hello", role: "client", version }));

  return {
    ws,
    messages: collector.messages,
    waitForMessage: collector.waitForMessage
  };
}

describe("HostRoom DO and Cloudflare Worker Relay", () => {
  beforeEach(() => {
    (env as any).HELLO_TIMEOUT_MS = undefined;
  });

  it("a host with a valid signed hello and two clients; a req/res/chunk/end round trip routed to the right client; an SSE-style multi-chunk stream", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey, "1.0.0");

    const client1 = await connectClient(hostId);
    const client2 = await connectClient(hostId);

    // Both clients receive presence from handshake
    const p1 = await client1.waitForMessage((m) => m.t === "presence");
    const p2 = await client2.waitForMessage((m) => m.t === "presence");
    expect(p1.online).toBe(true);
    expect(p2.online).toBe(true);

    // 1. Client 1 sends req
    client1.ws.send(JSON.stringify({
      t: "req",
      sid: "req-c1-01",
      method: "GET",
      path: "/api/tools/list",
      headers: { authorization: "Bearer secret-token" },
      body: null
    }));

    // Host receives req with rewritten sid (<conn>:<sid>)
    const hostReq = await host.waitForMessage((m) => m.t === "req");
    expect(hostReq.sid).toMatch(/^c_[a-f0-9]{8}:req-c1-01$/);
    expect(hostReq.method).toBe("GET");
    expect(hostReq.path).toBe("/api/tools/list");
    expect(hostReq.headers.authorization).toBe("Bearer secret-token");

    const rewrittenSid1 = hostReq.sid;

    // Host responds with res, chunk, end
    host.ws.send(JSON.stringify({
      t: "res",
      sid: rewrittenSid1,
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    host.ws.send(JSON.stringify({
      t: "chunk",
      sid: rewrittenSid1,
      data: '{"result":"tools"}'
    }));
    host.ws.send(JSON.stringify({
      t: "end",
      sid: rewrittenSid1
    }));

    // Client 1 receives res, chunk, end with original sid stripped of <conn>:
    const c1Res = await client1.waitForMessage((m) => m.t === "res" && m.sid === "req-c1-01");
    expect(c1Res.status).toBe(200);
    expect(c1Res.headers["content-type"]).toBe("application/json");

    const c1Chunk = await client1.waitForMessage((m) => m.t === "chunk" && m.sid === "req-c1-01");
    expect(c1Chunk.data).toBe('{"result":"tools"}');

    const c1End = await client1.waitForMessage((m) => m.t === "end" && m.sid === "req-c1-01");
    expect(c1End.error).toBeUndefined();

    // Verify Client 2 received NO res/chunk/end frames
    const c2ReqFrames = client2.messages.filter((m) => m.sid === "req-c1-01");
    expect(c2ReqFrames.length).toBe(0);

    // 2. Client 2 sends SSE-style multi-chunk stream
    client2.ws.send(JSON.stringify({
      t: "req",
      sid: "sse-stream-02",
      method: "GET",
      path: "/api/stream",
      headers: { accept: "text/event-stream" },
      body: null
    }));

    const hostSseReq = await host.waitForMessage((m) => m.t === "req" && m.sid.endsWith(":sse-stream-02"));
    const rewrittenSid2 = hostSseReq.sid;
    expect(rewrittenSid2).toMatch(/^c_[a-f0-9]{8}:sse-stream-02$/);

    // Host streams multiple chunks
    host.ws.send(JSON.stringify({
      t: "res",
      sid: rewrittenSid2,
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    host.ws.send(JSON.stringify({
      t: "chunk",
      sid: rewrittenSid2,
      data: "event: ping\ndata: 1\n\n"
    }));
    host.ws.send(JSON.stringify({
      t: "chunk",
      sid: rewrittenSid2,
      data: "event: ping\ndata: 2\n\n"
    }));
    host.ws.send(JSON.stringify({
      t: "chunk",
      sid: rewrittenSid2,
      data: "event: done\ndata: end\n\n"
    }));
    host.ws.send(JSON.stringify({
      t: "end",
      sid: rewrittenSid2
    }));

    // Client 2 receives the full stream
    const c2Res = await client2.waitForMessage((m) => m.t === "res" && m.sid === "sse-stream-02");
    expect(c2Res.status).toBe(200);

    await client2.waitForMessage((m) => m.t === "chunk" && m.data.includes("data: 1"));
    await client2.waitForMessage((m) => m.t === "chunk" && m.data.includes("data: 2"));
    await client2.waitForMessage((m) => m.t === "chunk" && m.data.includes("data: end"));
    await client2.waitForMessage((m) => m.t === "end" && m.sid === "sse-stream-02");

    // Client 1 received none of Client 2's frames
    const c1StreamFrames = client1.messages.filter((m) => m.sid === "sse-stream-02");
    expect(c1StreamFrames.length).toBe(0);

    host.ws.close();
    client1.ws.close();
    client2.ws.close();
  });

  it("host_offline", async () => {
    const { hostId } = await createKeyPair();

    const client = await connectClient(hostId);
    client.ws.send(JSON.stringify({
      t: "req",
      sid: "offline-req",
      method: "GET",
      path: "/healthz"
    }));

    const endMsg = await client.waitForMessage((m) => m.t === "end" && m.sid === "offline-req");
    expect(endMsg.error).toBe("host_offline");

    client.ws.close();
  });

  it("client close producing client_gone to the host", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey);

    const client = await connectClient(hostId);
    await new Promise((r) => setTimeout(r, 20));

    // Client closes socket
    client.ws.close();

    const goneMsg = await host.waitForMessage((m) => m.t === "end" && m.error === "client_gone");
    expect(goneMsg).toBeDefined();
    expect(goneMsg.sid).toMatch(/^c_[a-f0-9]{8}:\*$/);

    host.ws.close();
  });

  it("a wrong pubkey for a pinned host_id (4003)", async () => {
    const { keyPair: kp1, rawPubkey: raw1, hostId } = await createKeyPair();
    const host1 = await connectHost(hostId, kp1, raw1);
    host1.ws.close();
    await new Promise((r) => setTimeout(r, 30));

    // Connect second host to same host_id but with a different keypair kp2
    const { keyPair: kp2, rawPubkey: raw2 } = await createKeyPair();

    const res = await SELF.fetch(`http://example.com/host/${hostId}`, {
      headers: { Upgrade: "websocket" }
    });
    const ws2 = res.webSocket!;
    ws2.accept();

    const collector = attachMessageCollector(ws2);
    const challenge = await collector.waitForMessage((m) => m.t === "challenge");

    const sig2 = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, kp2.privateKey, new TextEncoder().encode(challenge.nonce))
    );

    ws2.send(JSON.stringify({
      t: "hello",
      role: "host",
      host_id: hostId,
      pubkey: bytesToBase64Url(raw2),
      sig: bytesToBase64Url(sig2),
      version: "1.0.0"
    }));

    const closed = await collector.waitForClose();
    expect(closed.code).toBe(4003);
  });

  it("no hello (4001)", async () => {
    (env as any).HELLO_TIMEOUT_MS = "150";

    const { hostId } = await createKeyPair();
    const res = await SELF.fetch(`http://example.com/host/${hostId}`, {
      headers: { Upgrade: "websocket" }
    });
    const ws = res.webSocket!;
    ws.accept();

    const collector = attachMessageCollector(ws);
    // Do not send hello
    const closed = await collector.waitForClose(1000);
    expect(closed.code).toBe(4001);
  });

  it("a replaced host socket (4009)", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host1 = await connectHost(hostId, keyPair, rawPubkey, "1.0.0");

    const collector1 = attachMessageCollector(host1.ws);
    const closePromise1 = collector1.waitForClose();

    // Second host socket connects with same valid credentials
    const host2 = await connectHost(hostId, keyPair, rawPubkey, "1.0.1");

    // First host socket must be closed with 4009
    const closed = await closePromise1;
    expect(closed.code).toBe(4009);

    host2.ws.close();
  });

  it("pairing by 6-digit code: /pair/resolve finds the host, rejects unknown codes, rate limits guessing", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey);
    const code = "482913";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    host.ws.send(JSON.stringify({ t: "pair_open", code_hash: codeHash, expires_at: Date.now() + 60000 }));
    await new Promise((r) => setTimeout(r, 30));
    const resolve = (c: string, ip: string) => SELF.fetch("http://example.com/pair/resolve", {
      method: "POST", body: JSON.stringify({ code: c }), headers: { "cf-connecting-ip": ip }
    });
    const found = await resolve(" 482913 ", "198.51.100.1");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ host_id: hostId });
    expect((await resolve("111111", "198.51.100.1")).status).toBe(404);
    expect((await resolve("abc", "198.51.100.1")).status).toBe(404);
    for (let i = 0; i < 7; i++) await resolve("000000", "198.51.100.1");
    const limited = await resolve("482913", "198.51.100.1");
    expect(limited.status).toBe(429);
    expect((await resolve("482913", "198.51.100.2")).status).toBe(200);
    expect((await SELF.fetch("http://example.com/pair/resolve")).status).toBe(404);
    host.ws.close();
  });

  it("pairing: success once, then bad_code on reuse, expiry, and the redeem rate limit", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey);
    const client = await connectClient(hostId);

    // 1. Success once:
    // Host opens pairing code "apple orange banana grape cherry kiwi"
    const code1 = "apple orange banana grape cherry kiwi";
    const digest1 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code1));
    const codeHash1 = Array.from(new Uint8Array(digest1)).map((b) => b.toString(16).padStart(2, "0")).join("");

    host.ws.send(JSON.stringify({
      t: "pair_open",
      code_hash: codeHash1,
      expires_at: Date.now() + 60000
    }));
    await new Promise((r) => setTimeout(r, 20));

    // Client redeems code1
    client.ws.send(JSON.stringify({
      t: "pair_redeem",
      rid: "rid-01",
      code: "Apple  Orange Banana Grape Cherry Kiwi", // Normalized to lowercase single-space
      device_name: "MacBook Pro"
    }));

    // Host receives forwarded redeem request
    const hostRedeem = await host.waitForMessage((m) => m.t === "pair_redeem");
    expect(hostRedeem.device_name).toBe("MacBook Pro");
    expect(hostRedeem.rid).toMatch(/^c_[a-f0-9]{8}:rid-01$/);

    // Host responds with token
    host.ws.send(JSON.stringify({
      t: "pair_result",
      rid: hostRedeem.rid,
      token: "connection-token-xyz"
    }));

    // Client receives token
    const clientResult = await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-01");
    expect(clientResult.token).toBe("connection-token-xyz");
    expect(clientResult.error).toBeUndefined();

    // 2. Reuse produces bad_code:
    client.ws.send(JSON.stringify({
      t: "pair_redeem",
      rid: "rid-02",
      code: code1,
      device_name: "MacBook Pro 2"
    }));

    const clientReuseResult = await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-02");
    expect(clientReuseResult.error).toBe("bad_code");

    // 3. Expiry:
    const code2 = "zebra lion tiger elephant monkey giraffe";
    const digest2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code2));
    const codeHash2 = Array.from(new Uint8Array(digest2)).map((b) => b.toString(16).padStart(2, "0")).join("");

    host.ws.send(JSON.stringify({
      t: "pair_open",
      code_hash: codeHash2,
      expires_at: Date.now() - 5000 // Already expired
    }));
    await new Promise((r) => setTimeout(r, 20));

    client.ws.send(JSON.stringify({
      t: "pair_redeem",
      rid: "rid-03",
      code: code2,
      device_name: "iPad"
    }));

    const clientExpiryResult = await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-03");
    expect(clientExpiryResult.error).toBe("bad_code");

    // 4. Redeem rate limit (5 attempts per room per 10 minutes):
    // Already did attempt 1 (rid-01), attempt 2 (rid-02), attempt 3 (rid-03).
    // Send attempt 4 and 5:
    client.ws.send(JSON.stringify({ t: "pair_redeem", rid: "rid-04", code: "wrong", device_name: "d4" }));
    await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-04");

    client.ws.send(JSON.stringify({ t: "pair_redeem", rid: "rid-05", code: "wrong", device_name: "d5" }));
    await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-05");

    // Attempt 6 must be rate limited!
    client.ws.send(JSON.stringify({ t: "pair_redeem", rid: "rid-06", code: "wrong", device_name: "d6" }));
    const clientRateLimitResult = await client.waitForMessage((m) => m.t === "pair_result" && m.rid === "rid-06");
    expect(clientRateLimitResult.error).toBe("rate_limited");

    host.ws.close();
    client.ws.close();
  });

  it("presence updates on connect and disconnect", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();

    // 1. Client connects when host is offline
    const client = await connectClient(hostId);
    const initialPresence = await client.waitForMessage((m) => m.t === "presence");
    expect(initialPresence.online).toBe(false);

    // 2. Host connects and handshakes
    const host = await connectHost(hostId, keyPair, rawPubkey, "2.3.4");

    // Client receives presence update with online: true
    const onlinePresence = await client.waitForMessage((m) => m.t === "presence" && m.online === true);
    expect(onlinePresence.online).toBe(true);
    expect(onlinePresence.version).toBe("2.3.4");

    // 3. Host disconnects
    host.ws.close();

    // Client receives presence update with online: false
    const offlinePresence = await client.waitForMessage((m) => m.t === "presence" && m.online === false && m.last_seen !== null);
    expect(offlinePresence.online).toBe(false);
    expect(typeof offlinePresence.last_seen).toBe("number");

    client.ws.close();
  });

  it("Worker routing: /healthz, /h/:id/presence, and invalid host_id 404 validation", async () => {
    // 1. healthz
    const healthRes = await SELF.fetch("http://example.com/healthz");
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).toBe("ok");

    const healthPost = await SELF.fetch("http://example.com/healthz", { method: "POST" });
    expect(healthPost.status).toBe(404);

    // 2. invalid host_id regex validation (must be 26 chars in [a-z2-7])
    const invalidIds = [
      "short",
      "toolong123456789012345678901234567",
      "invalidchars!@#$%^&*()_+123456",
      "UPPERCASEISNOTALLOWED23456"
    ];
    for (const badId of invalidIds) {
      const resHost = await SELF.fetch(`http://example.com/host/${badId}`);
      expect(resHost.status).toBe(404);

      const resClient = await SELF.fetch(`http://example.com/h/${badId}`);
      expect(resClient.status).toBe(404);

      const resPresence = await SELF.fetch(`http://example.com/h/${badId}/presence`);
      expect(resPresence.status).toBe(404);
    }

    // 3. GET /h/:id/presence for valid host
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const presResBefore = await SELF.fetch(`http://example.com/h/${hostId}/presence`);
    expect(presResBefore.status).toBe(200);
    const presJsonBefore = await presResBefore.json() as any;
    expect(presJsonBefore.online).toBe(false);

    const host = await connectHost(hostId, keyPair, rawPubkey, "3.0.0");
    const presResAfter = await SELF.fetch(`http://example.com/h/${hostId}/presence`);
    expect(presResAfter.status).toBe(200);
    const presJsonAfter = await presResAfter.json() as any;
    expect(presJsonAfter.online).toBe(true);
    expect(presJsonAfter.version).toBe("3.0.0");

    host.ws.close();
  });

  it("limits: 32 client sockets limit produces close 4029", async () => {
    const { hostId } = await createKeyPair();

    const clients: WebSocket[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await SELF.fetch(`http://example.com/h/${hostId}`, {
        headers: { Upgrade: "websocket" }
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket!;
      ws.accept();
      clients.push(ws);
    }

    // 33rd client
    const res33 = await SELF.fetch(`http://example.com/h/${hostId}`, {
      headers: { Upgrade: "websocket" }
    });
    expect(res33.status).toBe(101);
    const ws33 = res33.webSocket!;
    ws33.accept();

    const collector33 = attachMessageCollector(ws33);
    const closed = await collector33.waitForClose();
    expect(closed.code).toBe(4029);

    for (const ws of clients) {
      ws.close();
    }
  });

  it("limits: 120 req per client per minute", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey);
    const client = await connectClient(hostId);

    // Send 120 requests
    for (let i = 0; i < 120; i++) {
      client.ws.send(JSON.stringify({
        t: "req",
        sid: `r-${i}`,
        method: "GET",
        path: "/healthz"
      }));
    }

    // 121st request
    client.ws.send(JSON.stringify({
      t: "req",
      sid: "r-121",
      method: "GET",
      path: "/healthz"
    }));

    const rateLimited = await client.waitForMessage((m) => m.t === "end" && m.sid === "r-121");
    expect(rateLimited.error).toBe("rate_limited");

    host.ws.close();
    client.ws.close();
  });

  it("keepalive: ping returns pong", async () => {
    const { keyPair, rawPubkey, hostId } = await createKeyPair();
    const host = await connectHost(hostId, keyPair, rawPubkey);
    const client = await connectClient(hostId);

    host.ws.send(JSON.stringify({ t: "ping" }));
    const hostPong = await host.waitForMessage((m) => m.t === "pong");
    expect(hostPong.t).toBe("pong");

    client.ws.send(JSON.stringify({ t: "ping" }));
    const clientPong = await client.waitForMessage((m) => m.t === "pong");
    expect(clientPong.t).toBe("pong");

    host.ws.close();
    client.ws.close();
  });
});
