#!/bin/sh
# Configure this script's absolute Node/repository paths before using it as an MCP command.
# Supply the Keychain service name, service origin, and token variable NAME as arguments.
# The token itself never appears in argv or an app's JSON config. No output before exec.
set -eu
if [ "$#" -ne 3 ]; then
  echo 'Expected: KEYCHAIN_SERVICE SERVICE_ORIGIN TOKEN_ENV_NAME' >&2
  exit 1
fi
case "$3" in
  COLLECTIVE_CLAUDE_TOKEN|COLLECTIVE_CODEX_TOKEN|COLLECTIVE_ANTIGRAVITY_TOKEN|COLLECTIVE_MCP_TOKEN|SWARMAA_CLAUDE_TOKEN|SWARMAA_CODEX_TOKEN|SWARMAA_ANTIGRAVITY_TOKEN|SWARMAA_MCP_TOKEN) ;;
  *) echo 'Unsupported client token variable' >&2; exit 1 ;;
esac
swarmaa_mcp_secret=$(/usr/bin/security find-generic-password -s "$1" -w)
if [ -z "$swarmaa_mcp_secret" ]; then
  echo 'Keychain token is empty' >&2
  exit 1
fi
export "$3=$swarmaa_mcp_secret"
unset swarmaa_mcp_secret
exec /opt/homebrew/bin/node /ABSOLUTE/PATH/swarmaa/dist/src/stdio-proxy.js --url "$2" --token-env "$3"
