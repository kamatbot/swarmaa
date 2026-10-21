const frontendTools = new Set(['context_get', 'memory_search', 'memory_get', 'memory_propose', 'task_submit', 'task_get', 'task_list', 'task_continue', 'task_cancel', 'artifact_get', 'events_poll']);

export async function callCollective(name, args, { signal } = {}) {
  if (!frontendTools.has(name)) throw new Error('Tool is not available to the Grok frontend');
  const origin = new URL(process.env.COLLECTIVE_URL || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('COLLECTIVE_URL must be an HTTPS origin');
  const token = process.env.COLLECTIVE_GROK_TOKEN;
  if (!token || /[\r\n]/u.test(token)) throw new Error('COLLECTIVE_GROK_TOKEN is required');
  const response = await fetch(`${origin.origin}/api/tools/${name}`, {
    method: 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Collective request failed (${response.status})`); }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Collective response too large; request a smaller page');
      chunks.push(chunk);
    }
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Object.hasOwn(result, 'result')) throw new Error('Invalid Collective response');
  return result.result;
}
