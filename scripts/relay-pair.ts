import { createHash, randomInt } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The sole intentional display is to the owner, never to daemon logs.
  createPairing().then(code => process.stdout.write(`${code}\n`)).catch(() => { process.stderr.write('Pairing setup failed.\n'); process.exitCode = 1; });
}
