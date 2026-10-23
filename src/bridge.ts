import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadBridgeConfig, readTokenFile } from './bridge/config.js';
import { HttpToolClient } from './bridge/client.js';
import { BridgeWorker } from './bridge/worker.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath || args.some((arg, i) => !['--config', '--once'].includes(arg) && i !== configIndex + 1)) throw new Error('Usage: node dist/src/bridge.js --config /absolute/path/bridge.json [--once]');
  const config = await loadBridgeConfig(resolve(configPath));
  const token = config.token_file ? await readTokenFile(config.token_file) : process.env[config.token_env];
  if (!token) throw new Error(`Set ${config.token_env} or token_file before starting the bridge`);
  // Child environments are explicit allowlists. Do not print this token or pass it as argv.
  const client = new HttpToolClient(config.service_url, token, config.request_timeout_ms);
  const controller = new AbortController();
  const worker = new BridgeWorker(config, client);
  const deadline = process.env.BRIDGE_DRAIN_MAX_SECONDS;
  const maxSeconds = deadline === undefined ? undefined : Number(deadline);
  if (maxSeconds !== undefined && (!deadline?.trim() || !Number.isFinite(maxSeconds) || maxSeconds < 0 || maxSeconds * 1000 > 2147483647)) throw new Error('BRIDGE_DRAIN_MAX_SECONDS must be between 0 and 2147483.647');
  const stop = (): void => controller.abort();
  const drain = (): void => worker.drain(maxSeconds);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('SIGUSR2', drain);
  try { await worker.run(controller.signal, args.includes('--once')); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGUSR2', drain); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Bridge stopped: ${error instanceof Error ? error.message : 'configuration or startup failure'}\n`);
    process.exitCode = 1;
  });
}
