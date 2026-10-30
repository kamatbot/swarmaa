// Static assets answer Range requests with the whole file, and Safari won't play a <video> without 206 replies.
// Runs only for /film/* (run_worker_first), slicing the asset per the requested byte range.
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end ? { start, end } : 'unsatisfiable';
}

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const header = request.headers.get('Range');
    if (res.status !== 200 || !header) {
      const out = new Response(res.body, res);
      if (res.status === 200) out.headers.set('Accept-Ranges', 'bytes');
      return out;
    }
    const buf = await res.arrayBuffer(), size = buf.byteLength, range = byteRange(header, size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (!range) return new Response(buf, res);
    const headers = new Headers(res.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(buf.slice(range.start, range.end + 1), { status: 206, headers });
  },
};
