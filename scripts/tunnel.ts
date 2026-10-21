// Contract stub: replaced by the Cloudflare Tunnel implementation.
export interface TunnelResult { publicUrl: string; changed: string[] }

/** Publishes the local service at https://<hostname> through a named Cloudflare Tunnel and points .env at it. */
export async function setupTunnel(opts: { hostname: string; root: string; dry: boolean; log: (line: string) => void }): Promise<TunnelResult> {
  void opts; throw new Error('tunnel setup is not implemented yet');
}
