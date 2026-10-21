import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeMcpName, StdioHttpProxy } from '../src/stdio-proxy.js';

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
