import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { boundedResponse, MAX_HTTP_RESPONSE_BYTES } from './bridge/client.js';
import { serviceUrl } from './bridge/config.js';

type RpcId = string | number | null;
interface RpcMessage { jsonrpc: '2.0'; id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: unknown; }
const MAX_INPUT_BYTES = 1024 * 1024;

export function rpcError(id: RpcId, code: number, message: string): RpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function encodeMcpName(value: string): string {
  if (/^[\x20-\x7e\t]*$/u.test(value) && value.trim() === value && !value.startsWith('=?base64?')) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Stateless JSON HTTP MCP adapter. SSE / server-initiated requests are intentionally unsupported. */
export class StdioHttpProxy {
  private protocolVersion = '2025-11-25';
  private readonly endpoint: string;
  constructor(origin: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = `${serviceUrl(origin)}/mcp`;
    if (!token || /[\r\n]/u.test(token)) throw new Error('Set the client bearer token through the configured environment variable');
  }
  async forward(value: unknown): Promise<RpcMessage | undefined> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return rpcError(null, -32600, 'Expected one JSON-RPC message');
    const message = value as RpcMessage;
    const hasId = Object.hasOwn(message, 'id');
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) return rpcError(null, -32600, 'Invalid JSON-RPC request');
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocolVersion };
      // Modern MCP is self-contained per request. Mirror its metadata as routing headers;
      // never invent capabilities or silently upgrade a legacy client's protocol.
      const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : undefined;
      const meta = params?._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : undefined;
      const version = meta?.['io.modelcontextprotocol/protocolVersion'];
      if (version === '2026-07-28') {
        headers['MCP-Protocol-Version'] = version;
        headers['Mcp-Method'] = message.method;
        const name = message.method === 'resources/read' ? params?.uri : ['tools/call', 'prompts/get'].includes(message.method) ? params?.name : undefined;
        if (typeof name === 'string') headers['Mcp-Name'] = encodeMcpName(name);
      }
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers,
        body: JSON.stringify(message)
      });
      if (!hasId) { await response.body?.cancel(); return undefined; }
      if (!response.ok) { await response.body?.cancel(); return rpcError(message.id ?? null, -32000, `Collective MCP request failed (HTTP ${response.status})`); }
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) { await response.body?.cancel(); return rpcError(message.id ?? null, -32603, 'Expected JSON MCP response; this proxy does not handle SSE'); }
      const result = JSON.parse(await boundedResponse(response, MAX_HTTP_RESPONSE_BYTES)) as RpcMessage;
      if (result.jsonrpc !== '2.0' || result.id !== message.id || (!Object.hasOwn(result, 'result') && !Object.hasOwn(result, 'error'))) return rpcError(message.id ?? null, -32603, 'Invalid MCP response envelope');
      if (message.method === 'initialize' && result.result && typeof result.result === 'object' && 'protocolVersion' in result.result) {
        const version = (result.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(version)) this.protocolVersion = version;
      }
      return result;
    } catch { return hasId ? rpcError(message.id ?? null, -32603, 'MCP service unavailable, timed out, or returned an invalid response') : undefined; }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let origin = process.env.SWARMAA_URL ?? process.env.COLLECTIVE_URL;
  let tokenEnv = process.env.SWARMAA_MCP_TOKEN && !process.env.COLLECTIVE_MCP_TOKEN ? 'SWARMAA_MCP_TOKEN' : 'COLLECTIVE_MCP_TOKEN';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--url') origin = args[++i];
    else if (flag === '--token-env') tokenEnv = args[++i] ?? '';
    else throw new Error('Usage: stdio-proxy --url https://network.example --token-env COLLECTIVE_CLAUDE_TOKEN');
  }
  if (!origin || !/^(?:COLLECTIVE|SWARMAA)_[A-Z0-9_]+$/u.test(tokenEnv)) throw new Error('A service origin and COLLECTIVE_ or SWARMAA_ token variable name are required');
  const fallbackEnv = tokenEnv.startsWith('COLLECTIVE_') ? tokenEnv.replace(/^COLLECTIVE_/u, 'SWARMAA_') : tokenEnv.replace(/^SWARMAA_/u, 'COLLECTIVE_');
  const proxy = new StdioHttpProxy(origin, process.env[tokenEnv] ?? process.env[fallbackEnv] ?? '');
  // Iterating with backpressure prevents an unbounded promise queue from a noisy client.
  let pending = Buffer.alloc(0);
  const write = async (response: RpcMessage): Promise<void> => {
    if (!process.stdout.write(`${JSON.stringify(response)}\n`)) await new Promise<void>(resolveDrain => process.stdout.once('drain', resolveDrain));
  };
  for await (const chunk of process.stdin) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    pending = Buffer.concat([pending, incoming]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_INPUT_BYTES) throw new Error('MCP input line exceeded size limit');
      const line = pending.subarray(0, newline).toString('utf8').trim();
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch { await write(rpcError(null, -32700, 'Invalid JSON')); continue; }
      const response = await proxy.forward(value);
      if (response) await write(response);
    }
    if (pending.byteLength > MAX_INPUT_BYTES) throw new Error('MCP input line exceeded size limit');
  }
  if (pending.toString('utf8').trim()) await write(rpcError(null, -32700, 'MCP messages must end with a newline'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // stdout must contain JSON-RPC only. Avoid echoing secret-bearing arguments or URLs.
    process.stderr.write('Collective MCP proxy stopped. Check URL, token environment and client configuration.\n');
    process.exitCode = 1;
  });
}
