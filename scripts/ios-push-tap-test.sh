#!/bin/zsh
# Runs the push-tap UI test on the simulator, sending a push from the host while it waits.
# usage: scripts/ios-push-tap-test.sh <simulator udid> <derived data dir>
set -u
sim=$1; dd=$2; payload=$(mktemp -t push).json
printf '%s' '{"aps":{"alert":{"title":"Launch","body":"Replied"},"sound":"default"},"bot_id":"launch"}' > $payload
( sleep 25; for i in {1..12}; do xcrun simctl push $sim app.swarmaa.ios $payload >/dev/null 2>&1; sleep 6; done ) &
pusher=$!
cd "$(dirname $0)/../iOS-app" && xcodebuild test -project Swarmaa.xcodeproj -scheme Swarmaa -destination id=$sim -derivedDataPath $dd \
  -only-testing:SwarmaaUITests/NavigationTests/testTappingAPushDoesNotCrash 2>&1 | grep -E "error:|' (passed|failed)|crash|TEST (SUCCEEDED|FAILED)"
kill $pusher 2>/dev/null; rm -f $payload
