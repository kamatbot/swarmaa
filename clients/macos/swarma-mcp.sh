#!/bin/sh
# MCP stdio command for one local identity: swarma-mcp.sh IDENTITY [SERVICE_ORIGIN]
# Reads the token from the private .local/IDENTITY.json written by `npm run admin -- create --out`.
# The token never appears in argv, client config or output.
set -eu
case "${1:-}" in *[!a-z0-9-]*|'') echo 'Expected: IDENTITY [SERVICE_ORIGIN]' >&2; exit 1 ;; esac
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${SWARMA_NODE:-/opt/homebrew/bin/node}
COLLECTIVE_MCP_TOKEN=$("$NODE" -e 'process.stdout.write(require(process.argv[1]).token)' "$ROOT/.local/$1.json")
export COLLECTIVE_MCP_TOKEN
exec "$NODE" "$ROOT/dist/src/stdio-proxy.js" --url "${2:-http://127.0.0.1:8787}" --token-env COLLECTIVE_MCP_TOKEN
