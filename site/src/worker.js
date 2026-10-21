// swarmaa.com: static landing page assets plus the waitlist endpoint.
// ponytail: no rate limit or bot check on the waitlist; add Turnstile if signups get spammed.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/waitlist') {
      if (request.method !== 'POST') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
      let email = '';
      try { email = String((await request.json()).email ?? '').trim().toLowerCase(); } catch { /* invalid body falls through to the check below */ }
      if (email.length > 254 || !EMAIL.test(email)) return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
      // Keyed by address so repeat signups overwrite instead of duplicating.
      await env.WAITLIST.put(email, JSON.stringify({ joined_at: new Date().toISOString(), country: request.cf?.country ?? null }));
      return Response.json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  },
};
