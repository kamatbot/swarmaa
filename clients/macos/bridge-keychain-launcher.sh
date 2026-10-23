#!/bin/sh
# Configure these absolute paths and the Keychain item name before installing the launch agent.
set -eu
COLLECTIVE_WORKER_TOKEN=${SWARMAA_WORKER_TOKEN:-$(/usr/bin/security find-generic-password -s 'swarmaa-worker' -w)}
SWARMAA_WORKER_TOKEN=$COLLECTIVE_WORKER_TOKEN
export COLLECTIVE_WORKER_TOKEN SWARMAA_WORKER_TOKEN
exec /opt/homebrew/bin/node /ABSOLUTE/PATH/swarmaa/dist/src/bridge.js --config /ABSOLUTE/PATH/bridge.local.json
