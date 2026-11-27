import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyProxyError, encodeMcpName, readTokenFile, StdioHttpProxy } from '../src/stdio-proxy.js';

test('modern name header encodes Unicode, trimming and sentinel collisions', () => {
  assert.equal(encodeMcpName('context_get'),'context_get');
  for (const value of ['résumé', ' trailing ', '=?base64?aGVsbG8=?=']) {
    const encoded=encodeMcpName(value);
    assert.ok(encoded.startsWith('=?base64?') && encoded.endsWith('?='));
    assert.equal(Buffer.from(encoded.slice(9,-2),'base64').toString('utf8'),value);
  }
});

test('proxy supplies auth and protocol headers and forwards result IDs', async () => {
  const requests: RequestInit[]=[];
  const fetcher:typeof fetch=async(_input,init)=>{
    requests.push(init!);
    const message=JSON.parse(init!.body as string) as {id:number;method:string};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-11-25'}:{tools:[]}}),{headers:{'content-type':'application/json'}});
  };
  const proxy=new StdioHttpProxy('https://collective.example','test-token',fetcher);
  await proxy.forward({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  const result=await proxy.forward({jsonrpc:'2.0',id:2,method:'tools/list'});
  const headers=new Headers(requests[1]!.headers);
  assert.equal(headers.get('authorization'),'Bearer test-token');
  assert.equal(headers.get('mcp-protocol-version'),'2025-11-25');
  assert.ok(headers.get('accept')!.includes('text/event-stream'));
  assert.equal(requests[1]!.redirect,'error');
  assert.equal(result?.id,2);
});

test('modern MCP metadata is mirrored without fabricating client capabilities', async () => {
  const recorded:Headers[]=[];
  const fetcher:typeof fetch=async(_input,init)=>{recorded.push(new Headers(init?.headers));return new Response('{"jsonrpc":"2.0","id":4,"result":{}}',{headers:{'content-type':'application/json'}});};
  const proxy=new StdioHttpProxy('https://collective.example','test-token',fetcher);
  await proxy.forward({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'context_get',arguments:{scope:'project:demo'},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}});
  assert.equal(recorded[0]?.get('mcp-protocol-version'),'2026-07-28');
  assert.equal(recorded[0]?.get('mcp-method'),'tools/call');
  assert.equal(recorded[0]?.get('mcp-name'),'context_get');
});

test('notifications produce no stdout response and remote errors never echo secret bodies', async () => {
  const fetcher:typeof fetch=async()=>new Response('secret-token-in-upstream-error',{status:401});
  const proxy=new StdioHttpProxy('https://collective.example','test-token',fetcher);
  assert.equal(await proxy.forward({jsonrpc:'2.0',method:'notifications/initialized'}),undefined);
  const error=await proxy.forward({jsonrpc:'2.0',id:3,method:'tools/list'});
  assert.ok(!JSON.stringify(error).includes('secret-token'));
  assert.equal(error?.id,3);
});

test('token reader is called per request, so rotation and revocation apply without a restart', async () => {
  const auth: (string | null)[]=[];
  const fetcher:typeof fetch=async(_input,init)=>{
    auth.push(new Headers(init!.headers).get('authorization'));
    const message=JSON.parse(init!.body as string) as {id:number};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{}}),{headers:{'content-type':'application/json'}});
  };
  let token='first';
  const proxy=new StdioHttpProxy('https://collective.example',()=>token,fetcher);
  await proxy.forward({jsonrpc:'2.0',id:1,method:'tools/list'});
  token='second';
  await proxy.forward({jsonrpc:'2.0',id:2,method:'tools/list'});
  token='';
  await proxy.forward({jsonrpc:'2.0',id:3,method:'tools/list'});
  assert.deepEqual(auth,['Bearer first','Bearer second',null]);
});

test('readTokenFile supports both JSON identity files and raw token files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-token-file-'));
  try {
    const rawFile = join(dir, 'raw.tok');
    writeFileSync(rawFile, '  raw-secret-token\n');
    assert.equal(readTokenFile(rawFile), 'raw-secret-token');

    const jsonFile = join(dir, 'claude.json');
    writeFileSync(jsonFile, JSON.stringify({ id: 'p1', token: 'json-secret-token', scopes: ['project:a'] }));
    assert.equal(readTokenFile(jsonFile), 'json-secret-token');

    const emptyJsonFile = join(dir, 'empty.json');
    writeFileSync(emptyJsonFile, JSON.stringify({ id: 'p1' }));
    assert.equal(readTokenFile(emptyJsonFile), '');

    assert.equal(readTokenFile(join(dir, 'missing.tok')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyProxyError differentiates ECONNREFUSED, timeout, TLS, and invalid JSON with Swarmaa MCP wording', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.match(classifyProxyError(refused), /Swarmaa MCP service refused connection/i);

  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.match(classifyProxyError(timeout), /Swarmaa MCP request timed out/i);

  const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
  assert.match(classifyProxyError(tls), /Swarmaa MCP TLS verification failed/i);

  const badJson = new SyntaxError('Unexpected token < in JSON');
  assert.match(classifyProxyError(badJson), /invalid JSON/i);

  const proxy = new StdioHttpProxy('http://127.0.0.1:1', 'tok', async () => { throw refused; });
  const reply = await proxy.forward({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  assert.match(String((reply?.error as { message: string }).message), /Swarmaa MCP service refused connection/i);
});
