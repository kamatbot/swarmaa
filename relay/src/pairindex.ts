import { DurableObject } from "cloudflare:workers";

/**
 * Finds which host a 6-digit pairing code belongs to, so a phone only types the code.
 * One global instance. Each entry lives until the code's expiry (5 minutes). The host's
 * room still checks and consumes the code on redeem; this only maps hash -> host_id.
 */
// ponytail: a code colliding with another host's live code is refused (~1e-6 per pairing with few hosts); upgrade to longer codes if hosts grow.
const MAX_BODY_BYTES = 4096;

async function readBoundedJson<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const len = request.headers.get("content-length");
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > MAX_BODY_BYTES)) {
    return { ok: false, status: 413 };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400 };
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, status: 400 };
  }
}

export class PairIndex extends DurableObject {
  private async scheduleCleanup(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextAlarm: number | null = null;

    const codes = await this.ctx.storage.list<{ host_id: string; expires_at: number }>({ prefix: "c:" });
    const expiredKeys: string[] = [];
    for (const [key, entry] of codes) {
      if (!entry || entry.expires_at <= now) {
        expiredKeys.push(key);
      } else if (nextAlarm === null || entry.expires_at < nextAlarm) {
        nextAlarm = entry.expires_at;
      }
    }
    if (expiredKeys.length) {
      await this.ctx.storage.delete(expiredKeys);
    }

    const ipBuckets = await this.ctx.storage.list<number[]>({ prefix: "ip:" });
    const expiredIpKeys: string[] = [];
    for (const [key, tries] of ipBuckets) {
      const fresh = Array.isArray(tries) ? tries.filter(t => now - t < 600_000) : [];
      if (fresh.length === 0) {
        expiredIpKeys.push(key);
      } else {
        if (fresh.length !== tries.length) {
          await this.ctx.storage.put(key, fresh);
        }
        const expiresAt = fresh[0] + 600_000;
        if (nextAlarm === null || expiresAt < nextAlarm) {
          nextAlarm = expiresAt;
        }
      }
    }
    if (expiredIpKeys.length) {
      await this.ctx.storage.delete(expiredIpKeys);
    }

    if (nextAlarm !== null) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/register" && request.method === "POST") {
      const body = await readBoundedJson<{ code_hash: string; host_id: string; expires_at: number }>(request);
      if (!body.ok) return new Response(body.status === 413 ? "payload too large" : "bad request", { status: body.status });
      const { code_hash, host_id, expires_at } = body.data;
      if (typeof code_hash !== "string" || typeof host_id !== "string" || typeof expires_at !== "number"
        || !/^[a-f0-9]{64}$/.test(code_hash) || !/^[a-z2-7]{26}$/.test(host_id) || !(expires_at > now)) {
        return new Response("bad request", { status: 400 });
      }
      const key = `c:${code_hash}`;
      const existing = await this.ctx.storage.get<{ host_id: string; expires_at: number }>(key);
      if (existing && existing.expires_at > now && existing.host_id !== host_id) return new Response("collision", { status: 409 });
      const cappedExpiry = Math.min(expires_at, now + 300_000);
      await this.ctx.storage.put(key, { host_id, expires_at: cappedExpiry });
      await this.scheduleCleanup(cappedExpiry);
      return new Response("ok");
    }
    if (url.pathname === "/resolve" && request.method === "POST") {
      // Six digits are guessable: 10 lookups per caller IP per 10 minutes.
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const bucketKey = `ip:${ip}`;
      const tries = ((await this.ctx.storage.get<number[]>(bucketKey)) ?? []).filter(t => now - t < 600_000);
      if (tries.length >= 10) return Response.json({ error: "rate_limited" }, { status: 429 });
      tries.push(now);
      await this.ctx.storage.put(bucketKey, tries);
      await this.scheduleCleanup(tries[0] + 600_000);
      const body = await readBoundedJson<{ code: string }>(request);
      if (!body.ok) return Response.json({ error: body.status === 413 ? "payload_too_large" : "bad_request" }, { status: body.status });
      const { code } = body.data;
      if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return Response.json({ error: "bad_code" }, { status: 404 });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code.trim()));
      const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
      const key = `c:${hash}`;
      const entry = await this.ctx.storage.get<{ host_id: string; expires_at: number }>(key);
      if (!entry || entry.expires_at <= now) {
        if (entry) await this.ctx.storage.delete(key);
        return Response.json({ error: "bad_code" }, { status: 404 });
      }
      return Response.json({ host_id: entry.host_id });
    }
    return new Response("Not Found", { status: 404 });
  }
}
