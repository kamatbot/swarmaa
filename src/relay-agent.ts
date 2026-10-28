import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { constants, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, watchFile, unwatchFile, renameSync, unlinkSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createPool } from './db.js';
import { provisionRelayConnection } from './provision.js';

export function hostId(pubkey: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, out = '';
  for (const byte of createHash('sha256').update(pubkey).digest()) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  return out.slice(0, 26);
}
export function loadHostKey(directory: string): { key: KeyObject; pubkey: Buffer; id: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'relay-host.key');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })); } finally { closeSync(fd); }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: KeyObject;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Relay host key must have mode 0600');
    key = createPrivateKey(readFileSync(fd));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Relay host key must be Ed25519');
  } finally { closeSync(fd); }
  const pubkey = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
  return { key, pubkey, id: hostId(pubkey) };
}

export interface RelayOptions {
  relayUrl: string; publicUrl: string; host: string; port: number; directory: string;
  provision(device: string): Promise<string>;
  reconnectMinMs?: number; reconnectMaxMs?: number; pingMs?: number;
}
type Frame = Record<string, any>;
const requestHeaders = new Set(['authorization', 'accept', 'content-type', 'last-event-id']);
export class RelayAgent {
  readonly identity;
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private retry = 0;
  private reconnect?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private handshake?: NodeJS.Timeout;
  private streams = new Map<string, ClientRequest>();
  private pairingPath: string;
  private announced = '';
  constructor(private options: RelayOptions) {
    this.identity = loadHostKey(options.directory);
    this.pairingPath = resolve(options.directory, 'relay-pairing.json');
  }
  start(): void {
    watchFile(this.pairingPath, { interval: 500 }, () => this.announcePairing());
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    unwatchFile(this.pairingPath);
    clearTimeout(this.reconnect); clearInterval(this.ping); clearTimeout(this.handshake);
    this.abortAll(); this.socket?.close();
  }
  private send(frame: Frame, socket = this.socket): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
  private pending(path = this.pairingPath): { code_hash: string; expires_at: number } | undefined {
    try {
      const p = JSON.parse(readFileSync(path, 'utf8'));
      if (/^[a-f0-9]{64}$/.test(p.code_hash) && Number.isFinite(p.expires_at) && p.expires_at > Date.now()) return p;
    } catch { /* absent, expired or incomplete file */ }
    return undefined;
  }
  private announcePairing(): void {
    const p = this.pending();
    if (this.ready && p && this.announced !== p.code_hash) {
      this.send({ t: 'pair_open', code_hash: p.code_hash, expires_at: p.expires_at }); this.announced = p.code_hash;
    }
  }
  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(`${this.options.relayUrl.replace(/\/$/, '')}/host/${this.identity.id}`);
    this.socket = socket; this.ready = false; this.announced = '';
    this.handshake = setTimeout(() => socket.close(), 10_000);
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1024 * 1024) { socket.close(1009); return; }
      let f: Frame;
      try { f = JSON.parse(event.data); } catch { return; }
      if (!f || typeof f !== 'object') return;
      if (f.t === 'challenge' && !this.ready && typeof f.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(f.nonce)) {
        this.send({ t: 'hello', role: 'host', host_id: this.identity.id, pubkey: this.identity.pubkey.toString('base64url'), sig: sign(null, Buffer.from(f.nonce), this.identity.key).toString('base64url'), version: '1' }, socket);
        this.ready = true; this.retry = 0; clearTimeout(this.handshake);
        this.ping = setInterval(() => this.send({ t: 'ping' }, socket), this.options.pingMs ?? 25_000);
        this.announcePairing();
      } else if (this.ready) {
        if (f.t === 'ping') this.send({ t: 'pong' }, socket);
        else if (f.t === 'req') this.replay(f, socket);
        else if (f.t === 'end' && typeof f.sid === 'string') this.abort(f.sid);
        else if (f.t === 'pair_redeem' && typeof f.rid === 'string' && typeof f.device_name === 'string') void this.redeem(f, socket);
      }
    });
    socket.addEventListener('close', () => {
      this.ready = false; clearInterval(this.ping); clearTimeout(this.handshake); this.abortAll();
      if (!this.stopped) {
        const min = this.options.reconnectMinMs ?? 1000, max = this.options.reconnectMaxMs ?? 60_000;
        const ceiling = Math.min(max, min * 2 ** Math.min(this.retry++, 16));
        this.reconnect = setTimeout(() => this.connect(), min + Math.random() * (ceiling - min));
      }
    });
  }
  private abort(sid: string): void {
    for (const [id, req] of this.streams) if (id === sid || (sid.endsWith(':*') && id.startsWith(sid.slice(0, -1)))) {
      this.streams.delete(id); req.destroy();
    }
  }
  private abortAll(): void { for (const req of this.streams.values()) req.destroy(); this.streams.clear(); }
  private replay(f: Frame, socket: WebSocket): void {
    if (typeof f.sid !== 'string' || !f.sid || f.sid.length > 160) return;
    const end = (error?: string) => this.send({ t: 'end', sid: f.sid, ...(error ? { error } : {}) }, socket);
    // Validate the raw path: no URL normalization, escaped separators or dot traversal.
    if (typeof f.path !== 'string' || !/^(?:\/api\/tools\/[a-zA-Z0-9_-]+|\/api\/stream|\/api\/inbox\/wait|\/healthz)(?:\?[^#\r\n]*)?$/.test(f.path)) { end('forbidden_path'); return; }
    if (typeof f.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(f.method) || !(f.body === null || typeof f.body === 'string') || (f.body && Buffer.byteLength(f.body) > 512 * 1024)) { end('bad_request'); return; }
    if (this.streams.has(f.sid) || this.streams.size >= 2048) { end('rate_limited'); return; }
    const headers: Record<string, string> = { host: new URL(this.options.publicUrl).host };
    if (f.headers && typeof f.headers === 'object') for (const [name, value] of Object.entries(f.headers)) if (requestHeaders.has(name) && typeof value === 'string') headers[name] = value;
    try {
      const req = request({ hostname: this.options.host, port: this.options.port, method: f.method, path: f.path, headers }, response => {
        if (this.streams.get(f.sid) !== req) { response.destroy(); return; }
        const decoder = new StringDecoder('utf8');
        const responseHeaders: Record<string, string> = {};
        const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', ...(response.headers.connection ?? '').toLowerCase().split(/,\s*/)]);
        for (const [key, value] of Object.entries(response.headers)) if (!hop.has(key) && value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        this.send({ t: 'res', sid: f.sid, status: response.statusCode, headers: responseHeaders }, socket);
        const emit = (text: string) => {
          if (this.streams.get(f.sid) !== req) return;
          // 16K UTF-16 units occupy at most 48K UTF-8 bytes; never split a surrogate pair.
          while (text.length) {
            let size = Math.min(16384, text.length);
            if (size < text.length && /[\uD800-\uDBFF]/.test(text[size - 1])) size--;
            this.send({ t: 'chunk', sid: f.sid, data: text.slice(0, size) }, socket); text = text.slice(size);
          }
          if (socket.bufferedAmount > 8 * 1024 * 1024) finish('slow_client');
        };
        response.on('data', (chunk: Buffer) => emit(decoder.write(chunk)));
        response.on('end', () => { emit(decoder.end()); finish(); });
        response.on('error', () => finish('local_error'));
      });
      const finish = (error?: string) => {
        if (this.streams.get(f.sid) !== req) return;
        this.streams.delete(f.sid); end(error); if (error) req.destroy();
      };
      this.streams.set(f.sid, req);
      req.on('error', () => finish('local_error'));
      req.setTimeout(120_000, () => finish('local_timeout'));
      req.end(f.body);
    } catch { end('bad_request'); }
  }
  private async redeem(f: Frame, socket: WebSocket): Promise<void> {
    // Atomic consumption also fences concurrent redemptions and survives process restarts.
    const consumed = `${this.pairingPath}.${randomUUID()}.consumed`;
    try { renameSync(this.pairingPath, consumed); } catch { this.send({ t: 'pair_result', rid: f.rid, error: 'bad_code' }, socket); return; }
    try {
      if (!this.pending(consumed)) { this.send({ t: 'pair_result', rid: f.rid, error: 'bad_code' }, socket); return; }
      const token = await this.options.provision(f.device_name);
      this.send({ t: 'pair_result', rid: f.rid, token }, socket);
    } catch (e) {
      const error = e instanceof Error && ['template_missing', 'template_invalid'].includes(e.message) ? e.message : 'provision_failed';
      this.send({ t: 'pair_result', rid: f.rid, error }, socket);
    } finally { try { unlinkSync(consumed); } catch { /* already absent */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.env.DATABASE_URL || !process.env.PUBLIC_URL) throw new Error('configuration');
    const pool = createPool(process.env.DATABASE_URL);
    const agent = new RelayAgent({ relayUrl: process.env.RELAY_URL ?? 'wss://relay.swarmaa.com', publicUrl: process.env.PUBLIC_URL, host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787), directory: resolve('.local'), provision: device => provisionRelayConnection(pool, process.env.RELAY_PAIR_TEMPLATE ?? 'notchtrader', device) });
    process.stdout.write(`Relay host_id: ${agent.identity.id}\n`); agent.start();
    const stop = () => { agent.stop(); void pool.end(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { process.stderr.write('Relay agent startup failed; check configuration and key permissions.\n'); process.exitCode = 1; }
}
