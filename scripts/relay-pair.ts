import { createHash, randomInt } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A 6-digit code the owner types on the phone. The relay finds the host from it (POST /pair/resolve),
// and the host's room checks and consumes it once. It lives five minutes; guesses are rate limited.
export const codeHash = (code: string): string => createHash('sha256').update(code.trim().toLowerCase().split(/\s+/).join(' ')).digest('hex');
export async function createPairing(directory = resolve('.local')): Promise<string> {
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `relay-pairing-${process.pid}-${randomInt(0x1000000)}.tmp`);
  await writeFile(temporary, JSON.stringify({ code_hash: codeHash(code), expires_at: Date.now() + 300_000 }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, resolve(directory, 'relay-pairing.json'));
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The sole intentional display is to the owner, never to daemon logs.
  createPairing().then(code => process.stdout.write(`${code.slice(0, 3)} ${code.slice(3)}\nType it in Swarmaa on your phone within five minutes.\n`))
    .catch(() => { process.stderr.write('Pairing setup failed.\n'); process.exitCode = 1; });
}
