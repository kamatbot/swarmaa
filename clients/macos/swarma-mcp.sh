#!/bin/sh
# Swarmaa MCP stdio command for one local identity: swarma-mcp.sh IDENTITY [SERVICE_ORIGIN]
# Passes the private .local/IDENTITY.json to stdio-proxy via --token-file in a single Node process.
# The token never appears in argv, client config or output.
set -eu
case "${1:-}" in *[!a-z0-9-]*|'') echo 'Expected: IDENTITY [SERVICE_ORIGIN]' >&2; exit 1 ;; esac
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${SWARMAA_NODE:-${SWARMA_NODE:-}}
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  for c in "$ROOT/node" /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/opt/node@24/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE=$c; break; fi
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo 'Node.js was not found. Install Node 24 or set SWARMAA_NODE.' >&2
  exit 1
fi
# Default origin: the PORT from the install's .env (ignoring comments, export, and quotes), else 8787.
PORT=''
if [ -r "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line#"${line%%[![:space:]]*}"}
    case "$line" in '#'*|'') continue ;; esac
    case "$line" in export[[:space:]]*) line=${line#export}; line=${line#"${line%%[![:space:]]*}"} ;; esac
    case "$line" in
      PORT=*)
        val=${line#PORT=}
        val=${val%%#*}
        val=${val#"${val%%[![:space:]]*}"}
        val=${val%"${val##*[![:space:]]}"}
        case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
        case "$val" in ''|*[!0-9]*) ;; *) PORT=$val; break ;; esac
        ;;
    esac
  done < "$ROOT/.env"
fi
exec "$NODE" "$ROOT/dist/src/stdio-proxy.js" --url "${2:-http://127.0.0.1:${PORT:-8787}}" --token-file "$ROOT/.local/$1.json"
