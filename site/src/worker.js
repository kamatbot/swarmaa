// swarmaa.com: static landing page assets plus the waitlist endpoint.
// ponytail: no rate limit or bot check on the waitlist; add Turnstile if signups get spammed.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/waitlist') {
      if (request.method !== 'POST') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
      let email = '', invite = '';
      try { const body = await request.json(); email = String(body.email ?? '').trim().toLowerCase(); invite = String(body.invite ?? '').trim().toLowerCase(); } catch { /* invalid body falls through to the checks below */ }
      if (email.length > 254 || !EMAIL.test(email)) return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
      // Private beta: signups need the invite code, kept as a Worker secret (INVITE_CODE), never in the page.
      if (!env.INVITE_CODE || invite !== String(env.INVITE_CODE).toLowerCase()) return Response.json({ ok: false, error: 'invalid_invite' }, { status: 403 });
      // Keyed by address so repeat signups overwrite instead of duplicating.
      await env.WAITLIST.put(email, JSON.stringify({ invite, joined_at: new Date().toISOString(), country: request.cf?.country ?? null }));
      return Response.json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  },
};
