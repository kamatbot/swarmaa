import { DurableObject } from "cloudflare:workers";

/**
 * Finds which host a 6-digit pairing code belongs to, so a phone only types the code.
 * One global instance. Each entry lives until the code's expiry (5 minutes). The host's
 * room still checks and consumes the code on redeem; this only maps hash -> host_id.
 */
// ponytail: a code colliding with another host's live code is refused (~1e-6 per pairing with few hosts); upgrade to longer codes if hosts grow.
export class PairIndex extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/register" && request.method === "POST") {
      const { code_hash, host_id, expires_at } = await request.json<{ code_hash: string; host_id: string; expires_at: number }>();
      if (!/^[a-f0-9]{64}$/.test(code_hash) || !/^[a-z2-7]{26}$/.test(host_id) || !(expires_at > now)) {
        return new Response("bad request", { status: 400 });
      }
      const key = `c:${code_hash}`;
      const existing = await this.ctx.storage.get<{ host_id: string; expires_at: number }>(key);
      if (existing && existing.expires_at > now && existing.host_id !== host_id) return new Response("collision", { status: 409 });
      await this.ctx.storage.put(key, { host_id, expires_at: Math.min(expires_at, now + 300_000) });
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
      const { code } = await request.json<{ code: string }>();
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
