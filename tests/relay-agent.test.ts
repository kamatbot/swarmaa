import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayAgent, loadHostKey, hostId } from '../src/relay-agent.js';
import { createPairing, codeHash, PAIR_WORDS, createPairingDisplay, cleanupPairingDisplay, pairingLink } from '../scripts/relay-pair.js';
import { deployLocal, type DeployIO } from '../scripts/deploy-local.js';

type Frame = Record<string, any>;
// Minimal RFC6455 fixture: server text frames and masked client text/control frames.
// No production dependency or real relay connection is required.
class Peer {
  frames: Frame[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  constructor(readonly socket: Duplex, head: Buffer) {
    socket.on('error', () => {});
    socket.on('data', data => { this.buffer = Buffer.concat([this.buffer, data]); this.parse(); });
    if (head.length) { this.buffer = head; this.parse(); }
  }
  send(frame: Frame): void {
    const body = Buffer.from(JSON.stringify(frame));
    let header: Buffer;
    if (body.length < 126) header = Buffer.from([0x81, body.length]);
    else if (body.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
    this.socket.write(Buffer.concat([header, body]));
  }
  private parse(): void {
    while (this.buffer.length >= 2) {
      const b = this.buffer, opcode = b[0] & 15, masked = !!(b[1] & 128);
      let size = b[1] & 127, offset = 2;
      if (size === 126) { if (b.length < 4) return; size = b.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (b.length < 10) return; size = Number(b.readBigUInt64BE(2)); offset = 10; }
      if (b.length < offset + (masked ? 4 : 0) + size) return;
      const mask = b.subarray(offset, offset + 4); if (masked) offset += 4;
      const body = Buffer.from(b.subarray(offset, offset + size));
      if (masked) for (let i = 0; i < size; i++) body[i] ^= mask[i % 4];
      this.buffer = b.subarray(offset + size);
      if (opcode === 8) { this.socket.end(Buffer.from([0x88, 0])); return; }
      if (opcode === 1) this.frames.push(JSON.parse(body.toString()));
    }
  }
  async take(type: string, id?: string): Promise<Frame> {
    return until(() => {
      const index = this.frames.findIndex(f => f.t === type && (id === undefined || f.sid === id || f.rid === id));
      return index < 0 ? undefined : this.frames.splice(index, 1)[0];
    });
  }
}
async function until<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 300; i++) { const result = get(); if (result !== undefined) return result; await delay(10); }
  throw new Error('Timed out waiting for fixture event');
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function fixture(t: TestContext, handler = (_req: IncomingMessage, res: ServerResponse) => { res.end('{}'); }, provision = async (_device: string) => 'fixture-token') {
  const directory = await mkdtemp(join(tmpdir(), 'relay-agent-'));
  const service = createServer(handler), relay = createServer();
  const port = await listen(service), relayPort = await listen(relay), peers: Peer[] = [];
  const nonce = randomBytes(32).toString('base64url');
  const paths: string[] = [];
  relay.on('upgrade', (req, socket, head) => {
    paths.push(req.url!);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key']! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new Peer(socket, head); peers.push(peer); peer.send({ t: 'challenge', nonce });
  });
  const agent = new RelayAgent({ relayUrl: `ws://127.0.0.1:${relayPort}`, publicUrl: 'https://public.example:9443', host: '127.0.0.1', port, directory, provision, reconnectMinMs: 20, reconnectMaxMs: 80, pingMs: 30 });
  t.after(async () => {
    agent.stop(); for (const peer of peers) peer.socket.destroy();
    service.closeAllConnections(); relay.closeAllConnections();
    await Promise.all([new Promise<void>(r => service.close(() => r())), new Promise<void>(r => relay.close(() => r()))]);
    await rm(directory, { recursive: true, force: true });
  });
  agent.start();
  const peer = await until(() => peers[0]); const hello = await peer.take('hello');
  return { directory, agent, peer, peers, hello, nonce, paths };
}
const req = (sid: string, path = '/api/tools/context_get', headers: Record<string, string> = {}) => ({ t: 'req', sid, method: 'POST', path, headers, body: '{}' });

test('signed hello verifies against the derived host_id and challenge UTF-8 bytes', async t => {
  const f = await fixture(t), raw = Buffer.from(f.hello.pubkey, 'base64url');
  assert.equal(raw.length, 32); assert.equal(f.hello.role, 'host'); assert.equal(f.hello.version, '1');
  assert.equal(f.hello.host_id, hostId(raw)); assert.match(f.hello.host_id, /^[a-z2-7]{26}$/);
  // Independent bit-string base32 derivation, rather than relying only on the implementation helper.
  const bits = [...createHash('sha256').update(raw).digest()].map(b => b.toString(2).padStart(8, '0')).join('');
  const expected = Array.from({ length: 26 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join('');
  assert.equal(f.hello.host_id, expected);
  assert.equal(f.paths[0], `/host/${expected}`);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: f.hello.pubkey }, format: 'jwk' });
  assert.ok(verify(null, Buffer.from(f.nonce), key, Buffer.from(f.hello.sig, 'base64url')));
});

test('JSON tool round trip preserves body, status and response headers', async t => {
  const f = await fixture(t, (r, s) => {
    let body = ''; r.on('data', c => { body += c; }); r.on('end', () => {
      assert.equal(body, '{}'); s.writeHead(201, { 'content-type': 'application/json' }); s.end('{"result":"ok"}');
    });
  });
  f.peer.send(req('c:json'));
  const response = await f.peer.take('res', 'c:json'); assert.equal(response.status, 201); assert.equal(response.headers['content-type'], 'application/json');
  assert.equal((await f.peer.take('chunk', 'c:json')).data, '{"result":"ok"}');
  assert.deepEqual(await f.peer.take('end', 'c:json'), { t: 'end', sid: 'c:json' });
});

test('multi-chunk SSE streams live, bounds UTF-8 chunks, and aborts on end including conn wildcard', async t => {
  let closed = 0;
  const text = 'data: ' + '😀'.repeat(40000) + '\n\n';
  const f = await fixture(t, (_r, s) => { s.writeHead(200, { 'content-type': 'text/event-stream' }); s.write(text); s.on('close', () => closed++); });
  for (const sid of ['a:one', 'a:two', 'b:one']) {
    f.peer.send({ ...req(sid, '/api/stream'), method: 'GET', body: null });
    assert.equal((await f.peer.take('res', sid)).headers['content-type'], 'text/event-stream');
    let result = '', chunks = 0;
    while (result.length < text.length) { const chunk = await f.peer.take('chunk', sid); assert.ok(Buffer.byteLength(chunk.data) <= 65536); result += chunk.data; chunks++; }
    assert.equal(result, text); assert.ok(chunks > 1);
  }
  f.peer.send({ t: 'end', sid: 'a:*', error: 'client_gone' });
  await until(() => closed === 2 ? true : undefined);
  f.peer.send({ t: 'end', sid: 'b:one' });
  await until(() => closed === 3 ? true : undefined);
});

test('forbidden paths never reach local service, stripped headers and Host from PUBLIC_URL', async t => {
  let hits = 0;
  const f = await fixture(t, (r, s) => {
    hits++; assert.equal(r.headers.host, 'public.example:9443');
    for (const h of ['origin', 'cookie', 'x-forwarded-host', 'x-admin']) assert.equal(r.headers[h], undefined);
    assert.equal(r.headers.authorization, 'Bearer fixture'); assert.equal(r.headers.accept, 'application/json');
    assert.equal(r.headers['last-event-id'], 'cursor'); assert.equal(r.headers['content-type'], 'application/json'); s.end('{}');
  });
  for (const path of ['/mcp', '/account', '/api/tools/../admin', '//evil.example/api/stream', '/api/tools/%2e%2e', '/healthz#x']) {
    f.peer.send(req('c:deny', path)); assert.equal((await f.peer.take('end', 'c:deny')).error, 'forbidden_path');
  }
  assert.equal(hits, 0);
  f.peer.send(req('c:allow', '/api/tools/context_get', { host: 'evil', origin: 'https://evil', cookie: 'x', 'x-admin': 'true', 'x-forwarded-host': 'evil', authorization: 'Bearer fixture', accept: 'application/json', 'content-type': 'application/json', 'last-event-id': 'cursor' }));
  await f.peer.take('end', 'c:allow'); assert.equal(hits, 1);
});

test('reconnect after relay drop repeats signed hello and pending pair_open; keepalive ping/pong', async t => {
  const f = await fixture(t);
  await createPairing(f.directory);
  const initial = await f.peer.take('pair_open');
  await f.peer.take('ping'); f.peer.send({ t: 'ping' }); await f.peer.take('pong');
  f.peer.socket.destroy();
  const second = await until(() => f.peers[1]); await second.take('hello');
  assert.deepEqual(await second.take('pair_open'), initial);
});

test('pairing success consumes pending code, returns pair_result and rejects reused redemption', async t => {
  let minted = 0;
  const f = await fixture(t, undefined, async device => { assert.equal(device, 'My phone'); minted++; await delay(20); return 'fixture-token'; });
  await createPairing(f.directory); await f.peer.take('pair_open');
  f.peer.send({ t: 'pair_redeem', rid: 'c:first', device_name: 'My phone' });
  f.peer.send({ t: 'pair_redeem', rid: 'c:reuse', device_name: 'My phone' });
  assert.equal((await f.peer.take('pair_result', 'c:reuse')).error, 'bad_code');
  assert.equal((await f.peer.take('pair_result', 'c:first')).token, 'fixture-token');
  assert.equal(minted, 1); await assert.rejects(readFile(join(f.directory, 'relay-pairing.json')));
});

test('expired pairing and absent pending pairing reject without provisioning', async t => {
  const f = await fixture(t, undefined, async () => { throw new Error('must not provision'); });
  await writeFile(join(f.directory, 'relay-pairing.json'), JSON.stringify({ code_hash: 'a'.repeat(64), expires_at: Date.now() - 1 }), { mode: 0o600 });
  f.peer.send({ t: 'pair_redeem', rid: 'c:expired', device_name: 'phone' });
  assert.deepEqual(await f.peer.take('pair_result', 'c:expired'), { t: 'pair_result', rid: 'c:expired', error: 'bad_code' });
});

test('template_missing returns the binding pair_result error and consumes pending code', async t => {
  const f = await fixture(t, undefined, async () => { throw new Error('template_missing'); });
  await createPairing(f.directory); await f.peer.take('pair_open');
  f.peer.send({ t: 'pair_redeem', rid: 'c:missing', device_name: 'phone' });
  assert.equal((await f.peer.take('pair_result', 'c:missing')).error, 'template_missing');
  await assert.rejects(readFile(join(f.directory, 'relay-pairing.json')));
});

test('key creation is private and stable; key file permission refusal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-key-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = loadHostKey(directory); assert.equal(loadHostKey(directory).id, first.id);
  const file = join(directory, 'relay-host.key'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644); assert.throws(() => loadHostKey(directory), /mode 0600/);
});

test('six-word pairing uses at least 2048 distinct built-in words and stores only hash and five-minute expiry at 0600', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-pair-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(new Set(PAIR_WORDS).size >= 2048);
  const before = Date.now(), code = await createPairing(directory), words = code.split(' ');
  assert.equal(words.length, 6); assert.ok(words.every(w => PAIR_WORDS.includes(w)));
  const file = join(directory, 'relay-pairing.json'), data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['code_hash', 'expires_at']); assert.equal(data.code_hash, codeHash(code));
  assert.equal(codeHash('  ' + code.toUpperCase().replaceAll(' ', '   ') + ' '), data.code_hash);
  assert.ok(data.expires_at >= before + 300000 && data.expires_at <= Date.now() + 300000);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('relay launchd wiring is opt-in and dry-run performs no install', async () => {
  const calls: string[] = [];
  const io: DeployIO = { uid: 501, port: '8787', command: (c, a) => { calls.push(`${c} ${a.join(' ')}`); return ''; }, signal: () => {}, sleep: async () => {}, status: async () => [], healthy: async () => true, log: () => {}, installRelay: () => { calls.push('install'); return '/fixture/relay.plist'; } };
  await deployLocal(['--dry-run', '--relay'], io); assert.ok(!calls.includes('install'));
  calls.length = 0; await deployLocal(['--relay'], io);
  assert.ok(calls.includes('install')); assert.ok(calls.includes('launchctl bootstrap gui/501 /fixture/relay.plist')); assert.ok(calls.includes('launchctl kickstart -k gui/501/com.swarma.relay'));
});


test('pair link QR is a 0600 CoreImage PNG and disappears on consumption or expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-pair-qr-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = 'a'.repeat(26);
  const display = await createPairingDisplay(host, directory);
  // Boolean assertions keep generated pairing secrets out of failure output.
  assert.ok(display.link === `swarmaa://pair?host=${host}&code=${display.code.replaceAll(' ', '-')}`);
  assert.equal((await stat(display.path)).mode & 0o777, 0o600);
  assert.ok((await readFile(display.path)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile('/usr/bin/swift', ['-e', `
import Foundation
import CoreImage
let image = CIImage(data: FileHandle.standardInput.readDataToEndOfFile())!
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let qr = detector.features(in: image).first as! CIQRCodeFeature
FileHandle.standardOutput.write(qr.messageString!.data(using: .utf8)!)
`], { encoding: 'buffer', timeout: 60000 }, (error, output) => error ? reject(new Error('QR fixture decode failed')) : resolve(output));
    child.stdin!.end(display.png);
  });
  assert.ok(decoded.equals(Buffer.from(display.link)));
  assert.equal(await cleanupPairingDisplay(display, directory), false);
  await rm(join(directory, 'relay-pairing.json'));
  assert.equal(await cleanupPairingDisplay(display, directory), true);
  await assert.rejects(stat(display.path), { code: 'ENOENT' });
  const expired = await createPairingDisplay(host, directory);
  assert.equal(await cleanupPairingDisplay(expired, directory, Date.now() + 300001), true);
  await assert.rejects(stat(expired.path), { code: 'ENOENT' });
  assert.throws(() => pairingLink('invalid', 'fixture fixture fixture fixture fixture fixture'));
});


test('relay-pair --no-open displays words and link once and cleans the consumed QR', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-pair-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  loadHostKey(join(directory, '.local')); // Fresh test identity only.
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../scripts/relay-pair.ts', import.meta.url)), '--no-open'], {
    cwd: directory, env: { ...process.env, NODE_PATH: undefined }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  const completed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); child.on('exit', resolve);
  });
  const displayed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owner output timed out')), 60000);
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.split('\n').length >= 3) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', () => { clearTimeout(timeout); if (!output) reject(new Error('Owner command exited before display')); });
  });
  await displayed;
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1] === pairingLink(loadHostKey(join(directory, '.local')).id, lines[0]));
  const png = join(directory, '.local', 'relay-pairing-qr.png');
  assert.equal((await stat(png)).mode & 0o777, 0o600);
  await rm(join(directory, '.local', 'relay-pairing.json'));
  assert.equal(await completed, 0);
  await assert.rejects(stat(png), { code: 'ENOENT' });
  assert.equal(output.trim().split('\n').length, 2);
});
