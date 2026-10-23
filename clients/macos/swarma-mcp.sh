#!/bin/sh
# Swarmaa MCP stdio command for one local identity: swarma-mcp.sh IDENTITY [SERVICE_ORIGIN]
# Reads the token from the private .local/IDENTITY.json written by `npm run admin -- create --out`.
# The token never appears in argv, client config or output.
set -eu
case "${1:-}" in *[!a-z0-9-]*|'') echo 'Expected: IDENTITY [SERVICE_ORIGIN]' >&2; exit 1 ;; esac
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
if [ -x "$ROOT/node" ]; then NODE=${SWARMAA_NODE:-${SWARMA_NODE:-$ROOT/node}}; else NODE=${SWARMAA_NODE:-${SWARMA_NODE:-$( [ -x /opt/homebrew/opt/node@24/bin/node ] && echo /opt/homebrew/opt/node@24/bin/node || echo /opt/homebrew/bin/node )}}; fi
# Default origin: the PORT from the install's .env (the app may pick a non-default port), else 8787.
PORT=$(sed -n 's/^PORT=//p' "$ROOT/.env" 2>/dev/null | head -n1)
COLLECTIVE_MCP_TOKEN=$("$NODE" -e 'process.stdout.write(require(process.argv[1]).token)' "$ROOT/.local/$1.json")
SWARMAA_MCP_TOKEN=$COLLECTIVE_MCP_TOKEN
export COLLECTIVE_MCP_TOKEN SWARMAA_MCP_TOKEN
exec "$NODE" "$ROOT/dist/src/stdio-proxy.js" --url "${2:-http://127.0.0.1:${PORT:-8787}}" --token-env COLLECTIVE_MCP_TOKEN
