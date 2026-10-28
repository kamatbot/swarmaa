import { createHash, randomInt } from 'node:crypto';
import { mkdir, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadHostKey } from '../src/relay-agent.js';

// 2,048 distinct pronounceable compound words, assembled from fixed built-in lists.
const starts = 'amber apple autumn beach birch blue bright brook cedar cherry clear cloud coral dawn deep dune dusk elm fern field fire frost gold gray green hazel hill ice jade lake leaf light'.split(' ');
const ends = 'acorn alder anchor angel arch arrow ash aster badge bay beam bear bell berry bird bloom boat breeze bridge bud bush cake cave charm cliff coast comet crane creek crown crystal dale deer dew dove dragon dream drift eagle earth elm ember fawn feather finch flame flower forest fox garden gate gem glade glass glen globe grove gull harbor hare hawk hazel heart heron hill'.split(' ');
export const PAIR_WORDS = starts.flatMap(a => ends.map(b => a + b));
export const codeHash = (code: string): string => createHash('sha256').update(code.trim().toLowerCase().split(/\s+/).join(' ')).digest('hex');
export async function createPairing(directory = resolve('.local')): Promise<string> {
  const code = Array.from({ length: 6 }, () => PAIR_WORDS[randomInt(PAIR_WORDS.length)]).join(' ');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `relay-pairing-${process.pid}-${randomInt(0x1000000)}.tmp`);
  await writeFile(temporary, JSON.stringify({ code_hash: codeHash(code), expires_at: Date.now() + 300_000 }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, resolve(directory, 'relay-pairing.json'));
  return code;
}
export function pairingLink(host: string, code: string): string {
  if (!/^[a-z2-7]{26}$/.test(host) || !/^[a-z]+( [a-z]+){5}$/.test(code)) throw new Error('Invalid pairing material');
  return `swarmaa://pair?host=${host}&code=${code.replaceAll(' ', '-')}`;
}

// Input is private stdin, never argv or Swift diagnostics. CoreImage is part of macOS.
const qrHelper = `
import Foundation
import CoreImage
import AppKit
let input = FileHandle.standardInput.readDataToEndOfFile()
let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(input, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
let qr = filter.outputImage!
let paper = CIImage(color: CIColor.white).cropped(to: qr.extent.insetBy(dx: -4, dy: -4))
let image = qr.composited(over: paper).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
let bitmap = NSBitmapImageRep(cgImage: CIContext().createCGImage(image, from: image.extent)!)
FileHandle.standardOutput.write(bitmap.representation(using: .png, properties: [:])!)
`;
export async function renderPairingQR(link: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/swift', ['-e', qrHelper], { encoding: 'buffer', timeout: 60_000, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(new Error('QR rendering failed')); else resolve(stdout);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(link);
  });
}

export async function createPairingDisplay(host: string, directory = resolve('.local')) {
  const code = await createPairing(directory);
  const link = pairingLink(host, code);
  const png = await renderPairingQR(link);
  const path = resolve(directory, 'relay-pairing-qr.png');
  const temporary = resolve(directory, `relay-qr-${process.pid}-${randomInt(0x1000000)}.tmp`);
  await writeFile(temporary, png, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return { code, link, path, png, hash: codeHash(code) };
}

// Keep the owner command alive until consumed/expired. Never remove a newer QR.
export async function cleanupPairingDisplay(display: Awaited<ReturnType<typeof createPairingDisplay>>, directory: string, now = Date.now()): Promise<boolean> {
  try {
    const pending = JSON.parse(await readFile(resolve(directory, 'relay-pairing.json'), 'utf8'));
    if (pending.code_hash === display.hash && pending.expires_at > now) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Pairing cleanup failed');
  }
  try {
    const png = await readFile(display.path);
    if (png.equals(display.png)) await rm(display.path, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Pairing cleanup failed'); }
  return true;
}

async function main() {
  const directory = resolve('.local');
  const display = await createPairingDisplay(loadHostKey(directory).id, directory);
  // The sole intentional display is to the owner, never to daemon logs.
  process.stdout.write(`${display.code}\n${display.link}\n`);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (!process.argv.includes('--no-open')) {
      await new Promise<void>(resolve => execFile('/usr/bin/open', [display.path], { timeout: 5000 }, error => {
        if (error) process.stderr.write('Open the pairing QR PNG manually.\n');
        resolve();
      }));
    }
    while (!await cleanupPairingDisplay(display, directory)) await delay(250, undefined, { signal: abort.signal });
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await cleanupPairingDisplay(display, directory, Infinity);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Pairing setup failed.\n'); process.exitCode = 1; });
}
