import { HostRoom, type Env } from "./room";
import { PairIndex } from "./pairindex";

export { HostRoom, PairIndex, type Env };

const HOST_ID_REGEX = /^[a-z2-7]{26}$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // A phone types the 6-digit code; this says which host it belongs to.
    if (pathname === "/pair/resolve") {
      if (request.method !== "POST") return new Response("Not Found", { status: 404 });
      return env.PAIR_INDEX.get(env.PAIR_INDEX.idFromName("global")).fetch("https://index/resolve", {
        method: "POST", body: await request.text(),
        headers: { "cf-connecting-ip": request.headers.get("cf-connecting-ip") ?? "unknown" }
      });
    }

    const presenceMatch = pathname.match(/^\/h\/([^/]+)\/presence$/);
    if (presenceMatch) {
      if (request.method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }
      const hostId = presenceMatch[1];
      if (!HOST_ID_REGEX.test(hostId)) {
        return new Response("Not Found", { status: 404 });
      }
      const id = env.HOST_ROOM.idFromName(hostId);
      const stub = env.HOST_ROOM.get(id);
      return stub.fetch(request);
    }

    const clientMatch = pathname.match(/^\/h\/([^/]+)$/);
    if (clientMatch) {
      if (request.method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }
      const hostId = clientMatch[1];
      if (!HOST_ID_REGEX.test(hostId)) {
        return new Response("Not Found", { status: 404 });
      }
      const id = env.HOST_ROOM.idFromName(hostId);
      const stub = env.HOST_ROOM.get(id);
      return stub.fetch(request);
    }

    const hostMatch = pathname.match(/^\/host\/([^/]+)$/);
    if (hostMatch) {
      if (request.method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }
      const hostId = hostMatch[1];
      if (!HOST_ID_REGEX.test(hostId)) {
        return new Response("Not Found", { status: 404 });
      }
      const id = env.HOST_ROOM.idFromName(hostId);
      const stub = env.HOST_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
