# Apple Watch companion

The paired iPhone relays Watch requests through its existing Swarmaa connection. The Watch stores a bounded outbox and recent, abbreviated text snapshots; it receives no connection token. Messages are queued before transfer and retain the same idempotency key across retries. Delivered means the phone received a successful `thread_post` result from the server; a failure may be ambiguous and Retry uses the same key. The list contains at most 20 visible bots selected from the first 100 returned by the phone, with the starred bot first, and up to five recent text messages per bot. Longer messages end with an ellipsis, and some older messages may be omitted to keep the snapshot within 48 KB. Tap Refresh messages in a thread to retrieve newer replies; refresh is manual. Photos, approvals and other rich cards remain on the phone.

WatchConnectivity background delivery is scheduled by the system and may be delayed. The paired iPhone and its Swarmaa connection are required; the Watch has no independent cellular connection to the service. Open the phone app after pairing, reconnecting or changing accounts. Signing out clears the Watch when the devices next exchange state; the Watch may display cached content until then. A changed account discards the previous account's pending messages on the Watch. Messages already confirmed by the server cannot be recalled.

## Paired-device review checklist

- Generate the Xcode project and install both targets on a paired iPhone and Watch, sign in on the phone, and confirm the starred bot and recent messages appear. Check large text and VoiceOver labels on both screens.
- Dictate in the system text field, edit the transcript, tap Send, and confirm the same message and subsequent bot response appear on the Mac and phone.
- Disconnect the devices, send a message and restart the Watch app; confirm Pending survives. Reconnect and confirm one server message and a Delivered state, including after retries and dropped acknowledgements.
- Force an unavailable phone/server and verify Pending or Delivery unconfirmed and Retry. Reconnect, retry, and check no duplicate server message appears.
- Sign out or pair the phone to a different host with queued messages; reconnect and confirm old history disappears and old messages never reach the new host. Exercise delayed messages and unpair/re-pair.
- Check empty bot lists, maximum-sized messages, a full outbox, background delivery delay and a restart of each app. Verify that no token appears in WatchConnectivity payloads.

This source change has not been built or tested on a simulator or device.
