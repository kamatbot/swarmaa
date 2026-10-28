import { DurableObject } from "cloudflare:workers";

export interface Env {
  HOST_ROOM: DurableObjectNamespace<HostRoom>;
  HELLO_TIMEOUT_MS?: string;
}

export interface HostAttachment {
  type: "host";
  hostId: string;
  nonce: string;
  authed: boolean;
  version?: string;
  replaced?: boolean;
  connectedAt: number;
}

export interface ClientAttachment {
  type: "client";
  connId: string;
  authed: boolean;
  openStreams: string[];
  reqTimestamps: number[];
}

export type SocketAttachment = HostAttachment | ClientAttachment;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function computeHostId(rawPubkey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawPubkey);
  return base32Encode(new Uint8Array(digest)).slice(0, 26);
}

export class HostRoom extends DurableObject<Env> {
  private getActiveHostSocket(): WebSocket | null {
    const hostSockets = this.ctx.getWebSockets("host");
    for (const ws of hostSockets) {
      try {
        if (ws.readyState !== 1) continue;
        const att = ws.deserializeAttachment() as HostAttachment | null;
        if (att && att.type === "host" && att.authed && !att.replaced) {
          return ws;
        }
      } catch {}
    }
    return null;
  }

  private isHostOnline(): boolean {
    return this.getActiveHostSocket() !== null;
  }

  private getClientSocket(connId: string): WebSocket | null {
    const tagged = this.ctx.getWebSockets(connId);
    for (const ws of tagged) {
      if (ws.readyState === 1) return ws;
    }

    const clientSockets = this.ctx.getWebSockets("client");
    for (const ws of clientSockets) {
      try {
        if (ws.readyState !== 1) continue;
        const att = ws.deserializeAttachment() as ClientAttachment | null;
        if (att && att.type === "client" && att.connId === connId) {
          return ws;
        }
      } catch {}
    }
    return null;
  }

  private broadcastPresenceToClients(online: boolean, lastSeen: number | null, version: string | null) {
    const clientSockets = this.ctx.getWebSockets("client");
    const msg = JSON.stringify({ t: "presence", online, last_seen: lastSeen, version });
    for (const clientWs of clientSockets) {
      try {
        if (clientWs.readyState === 1) {
          clientWs.send(msg);
        }
      } catch {}
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.endsWith("/presence")) {
      const online = this.isHostOnline();
      const lastSeen = (await this.ctx.storage.get<number>("last_seen")) ?? null;
      const version = (await this.ctx.storage.get<string>("version")) ?? null;
      return Response.json({ online, last_seen: lastSeen, version });
    }

    if (pathname.startsWith("/host/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const hostId = pathname.slice("/host/".length);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = bytesToBase64Url(nonceBytes);

      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        type: "host",
        hostId,
        nonce,
        authed: false,
        connectedAt: Date.now()
      } satisfies HostAttachment);

      server.send(JSON.stringify({ t: "challenge", nonce }));

      const timeoutMs = this.env.HELLO_TIMEOUT_MS
        ? parseInt(this.env.HELLO_TIMEOUT_MS, 10)
        : 10000;

      setTimeout(() => {
        try {
          const att = server.deserializeAttachment() as HostAttachment | null;
          if (att && !att.authed) {
            server.close(4001, "no_hello");
          }
        } catch {}
      }, timeoutMs);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (pathname.startsWith("/h/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const clientSockets = this.ctx.getWebSockets("client").filter(ws => ws.readyState === 1);
      if (clientSockets.length >= 32) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, ["client"]);
        server.close(4029, "socket_limit_exceeded");
        return new Response(null, { status: 101, webSocket: client });
      }

      const connId = `c_${crypto.randomUUID().slice(0, 8)}`;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server, ["client", connId]);
      server.serializeAttachment({
        type: "client",
        connId,
        authed: false,
        openStreams: [],
        reqTimestamps: []
      } satisfies ClientAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let text: string;
    if (typeof message === "string") {
      if (message.length > 1024 * 1024) return;
      text = message;
    } else {
      if (message.byteLength > 1024 * 1024) return;
      text = new TextDecoder().decode(message);
    }

    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (!frame || typeof frame !== "object" || typeof frame.t !== "string") {
      return;
    }

    let att: SocketAttachment | null = null;
    try {
      att = ws.deserializeAttachment() as SocketAttachment | null;
    } catch {}

    if (!att) return;

    if (att.type === "host") {
      await this.handleHostMessage(ws, att, frame);
    } else if (att.type === "client") {
      await this.handleClientMessage(ws, att, frame);
    }
  }

  private async handleHostMessage(ws: WebSocket, att: HostAttachment, frame: any): Promise<void> {
    if (!att.authed) {
      if (frame.t !== "hello") return;

      if (
        frame.role !== "host" ||
        typeof frame.host_id !== "string" ||
        typeof frame.pubkey !== "string" ||
        typeof frame.sig !== "string"
      ) {
        ws.close(4001, "invalid_hello");
        return;
      }

      if (frame.host_id !== att.hostId) {
        ws.close(4001, "host_id_mismatch");
        return;
      }

      // Check pinned pubkey first: if already pinned and differs, close with 4003
      const pinnedPubkey = await this.ctx.storage.get<string>("pinned_pubkey");
      if (pinnedPubkey && pinnedPubkey !== frame.pubkey) {
        ws.close(4003, "pubkey_mismatch");
        return;
      }

      let rawPubkey: Uint8Array;
      let rawSig: Uint8Array;
      try {
        rawPubkey = base64UrlToBytes(frame.pubkey);
        rawSig = base64UrlToBytes(frame.sig);
      } catch {
        ws.close(4001, "invalid_base64url");
        return;
      }

      if (rawPubkey.length !== 32 || rawSig.length !== 64) {
        ws.close(4001, "invalid_key_length");
        return;
      }

      const derivedHostId = await computeHostId(rawPubkey);
      if (derivedHostId !== frame.host_id) {
        ws.close(4001, "host_id_mismatch");
        return;
      }

      try {
        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          rawPubkey,
          { name: "Ed25519" },
          false,
          ["verify"]
        );
        const valid = await crypto.subtle.verify(
          "Ed25519",
          cryptoKey,
          rawSig,
          new TextEncoder().encode(att.nonce)
        );
        if (!valid) {
          ws.close(4001, "invalid_signature");
          return;
        }
      } catch {
        ws.close(4001, "signature_error");
        return;
      }

      if (!pinnedPubkey) {
        await this.ctx.storage.put("pinned_pubkey", frame.pubkey);
      }

      const now = Date.now();
      const version = typeof frame.version === "string" ? frame.version : "";
      await this.ctx.storage.put("last_seen", now);
      await this.ctx.storage.put("version", version);

      // A second host socket replaces the first, which is closed with 4009.
      const hostSockets = this.ctx.getWebSockets("host");
      for (const otherWs of hostSockets) {
        if (otherWs !== ws) {
          try {
            const otherAtt = otherWs.deserializeAttachment() as HostAttachment | null;
            if (otherAtt) {
              otherAtt.replaced = true;
              otherWs.serializeAttachment(otherAtt);
            }
            otherWs.close(4009, "replaced");
          } catch {}
        }
      }

      att.authed = true;
      att.version = version;
      ws.serializeAttachment(att);

      this.broadcastPresenceToClients(true, now, version);
      return;
    }

    switch (frame.t) {
      case "ping": {
        ws.send(JSON.stringify({ t: "pong" }));
        break;
      }
      case "res": {
        if (typeof frame.sid !== "string") return;
        const colonIdx = frame.sid.indexOf(":");
        if (colonIdx === -1) return;
        const connId = frame.sid.slice(0, colonIdx);
        const clientSid = frame.sid.slice(colonIdx + 1);
        const clientWs = this.getClientSocket(connId);
        if (clientWs) {
          clientWs.send(JSON.stringify({ ...frame, sid: clientSid }));
        }
        break;
      }
      case "chunk": {
        if (typeof frame.sid !== "string") return;
        if (typeof frame.data !== "string" || frame.data.length > 64 * 1024) return;
        const colonIdx = frame.sid.indexOf(":");
        if (colonIdx === -1) return;
        const connId = frame.sid.slice(0, colonIdx);
        const clientSid = frame.sid.slice(colonIdx + 1);
        const clientWs = this.getClientSocket(connId);
        if (clientWs) {
          clientWs.send(JSON.stringify({ ...frame, sid: clientSid }));
        }
        break;
      }
      case "end": {
        if (typeof frame.sid !== "string") return;
        const colonIdx = frame.sid.indexOf(":");
        if (colonIdx === -1) return;
        const connId = frame.sid.slice(0, colonIdx);
        const clientSid = frame.sid.slice(colonIdx + 1);
        const clientWs = this.getClientSocket(connId);
        if (clientWs) {
          clientWs.send(JSON.stringify({ ...frame, sid: clientSid }));
          try {
            const clientAtt = clientWs.deserializeAttachment() as ClientAttachment | null;
            if (clientAtt && clientAtt.type === "client") {
              clientAtt.openStreams = (clientAtt.openStreams || []).filter(s => s !== clientSid);
              clientWs.serializeAttachment(clientAtt);
            }
          } catch {}
        }
        break;
      }
      case "pair_open": {
        if (typeof frame.code_hash !== "string" || typeof frame.expires_at !== "number") return;
        await this.ctx.storage.put("pending_pairing", {
          code_hash: frame.code_hash,
          expires_at: frame.expires_at
        });
        break;
      }
      case "pair_result": {
        if (typeof frame.rid !== "string") return;
        const colonIdx = frame.rid.indexOf(":");
        if (colonIdx === -1) return;
        const connId = frame.rid.slice(0, colonIdx);
        const clientRid = frame.rid.slice(colonIdx + 1);
        const clientWs = this.getClientSocket(connId);
        if (clientWs) {
          clientWs.send(JSON.stringify({ ...frame, rid: clientRid }));
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleClientMessage(ws: WebSocket, att: ClientAttachment, frame: any): Promise<void> {
    switch (frame.t) {
      case "hello": {
        if (frame.role !== "client") return;
        att.authed = true;
        ws.serializeAttachment(att);

        const online = this.isHostOnline();
        const lastSeen = (await this.ctx.storage.get<number>("last_seen")) ?? null;
        const version = (await this.ctx.storage.get<string>("version")) ?? null;
        ws.send(JSON.stringify({
          t: "presence",
          online,
          last_seen: lastSeen,
          version
        }));
        break;
      }
      case "ping": {
        ws.send(JSON.stringify({ t: "pong" }));
        break;
      }
      case "req": {
        if (typeof frame.sid !== "string" || frame.sid.length > 32) return;

        const now = Date.now();
        att.reqTimestamps = (att.reqTimestamps || []).filter(ts => now - ts < 60000);
        if (att.reqTimestamps.length >= 120) {
          ws.send(JSON.stringify({ t: "end", sid: frame.sid, error: "rate_limited" }));
          return;
        }
        att.reqTimestamps.push(now);

        att.openStreams = att.openStreams || [];
        if (att.openStreams.length >= 64) {
          ws.send(JSON.stringify({ t: "end", sid: frame.sid, error: "rate_limited" }));
          return;
        }

        const hostWs = this.getActiveHostSocket();
        if (!hostWs) {
          ws.send(JSON.stringify({ t: "end", sid: frame.sid, error: "host_offline" }));
          return;
        }

        att.openStreams.push(frame.sid);
        ws.serializeAttachment(att);

        if (frame.headers && typeof frame.headers === "object") {
          const allowed = ["authorization", "accept", "content-type", "last-event-id"];
          const sanitized: Record<string, string> = {};
          for (const [k, v] of Object.entries(frame.headers)) {
            const lk = k.toLowerCase();
            if (allowed.includes(lk) && typeof v === "string") {
              sanitized[lk] = v;
            }
          }
          frame.headers = sanitized;
        }

        const rewrittenSid = `${att.connId}:${frame.sid}`;
        hostWs.send(JSON.stringify({
          ...frame,
          sid: rewrittenSid
        }));
        break;
      }
      case "end": {
        if (typeof frame.sid !== "string") return;
        att.openStreams = (att.openStreams || []).filter(s => s !== frame.sid);
        ws.serializeAttachment(att);

        const hostWs = this.getActiveHostSocket();
        if (hostWs) {
          const rewrittenSid = `${att.connId}:${frame.sid}`;
          hostWs.send(JSON.stringify({
            ...frame,
            sid: rewrittenSid
          }));
        }
        break;
      }
      case "pair_redeem": {
        if (typeof frame.rid !== "string") return;

        const now = Date.now();
        let redeemAttempts = (await this.ctx.storage.get<number[]>("pair_redeem_attempts")) || [];
        redeemAttempts = redeemAttempts.filter(ts => now - ts < 600000);
        if (redeemAttempts.length >= 5) {
          ws.send(JSON.stringify({ t: "pair_result", rid: frame.rid, error: "rate_limited" }));
          return;
        }
        redeemAttempts.push(now);
        await this.ctx.storage.put("pair_redeem_attempts", redeemAttempts);

        const pending = await this.ctx.storage.get<{ code_hash: string; expires_at: number }>("pending_pairing");
        if (!pending) {
          ws.send(JSON.stringify({ t: "pair_result", rid: frame.rid, error: "bad_code" }));
          return;
        }

        if (now >= pending.expires_at) {
          await this.ctx.storage.delete("pending_pairing");
          ws.send(JSON.stringify({ t: "pair_result", rid: frame.rid, error: "bad_code" }));
          return;
        }

        const codeStr = typeof frame.code === "string" ? frame.code : "";
        const normalizedCode = codeStr.trim().toLowerCase().replace(/\s+/g, " ");
        const codeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedCode));
        const hexHash = Array.from(new Uint8Array(codeDigest))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");

        if (hexHash !== pending.code_hash) {
          ws.send(JSON.stringify({ t: "pair_result", rid: frame.rid, error: "bad_code" }));
          return;
        }

        // Consumed (one use)
        await this.ctx.storage.delete("pending_pairing");

        const hostWs = this.getActiveHostSocket();
        if (!hostWs) {
          ws.send(JSON.stringify({ t: "pair_result", rid: frame.rid, error: "host_offline" }));
          return;
        }

        const rewrittenRid = `${att.connId}:${frame.rid}`;
        hostWs.send(JSON.stringify({
          t: "pair_redeem",
          rid: rewrittenRid,
          device_name: frame.device_name
        }));
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    let att: SocketAttachment | null = null;
    try {
      att = ws.deserializeAttachment() as SocketAttachment | null;
    } catch {}

    if (!att) return;

    if (att.type === "host") {
      att.authed = false;
      try {
        ws.serializeAttachment(att);
      } catch {}

      if (!att.replaced) {
        const activeHost = this.getActiveHostSocket();
        if (!activeHost) {
          const now = Date.now();
          await this.ctx.storage.put("last_seen", now);
          const version = (await this.ctx.storage.get<string>("version")) ?? null;
          this.broadcastPresenceToClients(false, now, version);
        }
      }
    } else if (att.type === "client") {
      const hostWs = this.getActiveHostSocket();
      if (hostWs) {
        try {
          hostWs.send(JSON.stringify({
            t: "end",
            sid: `${att.connId}:*`,
            error: "client_gone"
          }));
        } catch {}
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    try {
      ws.close();
    } catch {}
  }
}
