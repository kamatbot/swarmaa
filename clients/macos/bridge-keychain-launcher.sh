#!/bin/sh
# Configure these absolute paths and the Keychain item name before installing the launch agent.
set -eu
COLLECTIVE_WORKER_TOKEN=$(/usr/bin/security find-generic-password -s 'collective-worker-mini' -w)
export COLLECTIVE_WORKER_TOKEN
exec /opt/homebrew/bin/node /ABSOLUTE/PATH/collective-network/dist/src/bridge.js --config /ABSOLUTE/PATH/bridge.local.json
