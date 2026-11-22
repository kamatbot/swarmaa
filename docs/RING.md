# SR116 ring voice memos (iOS)

Swarmaa's iOS app owns the SR116 ring's **recordings**; FitOdds only reads its
health history (disjoint command sets, so both can share the ring's BLE link).
Protocol reference: kamatbot/fitodds `docs/SR116-PROTOCOL.md`; codec copy in
`iOS-app/Sources/RingProtocol.swift` (keep in sync).

Flow (`iOS-app/Sources/RingLink.swift`):

1. Restorable `CBCentralManager` (`app.swarmaa.ring.v1`, `bluetooth-central`
   background mode) holds a pending connection to the paired ring (56FF,
   write 33F3, notify 33F4), so iOS wakes Swarmaa on ring notifications.
2. Ring pushes audio state 0x2F: 0x50 recording → 0x40 idle. On that falling
   edge, and on every (re)connect, Swarmaa asks for the file count (0x3D) and
   acts only on a count reply to its own request (other apps' replies are
   broadcast on the same channel).
3. Download: 0x40 stop stale transfer, 1 s, 0x34. Packets 1…T must arrive in
   order (fail closed); 20 s inactivity aborts. Ring sends 0x36 + remaining.
4. Opus (16 kHz mono, 40-byte packets) → AAC M4A in the Watch memo folder,
   re-read to verify, then **0x36 delete-ack** echoing the remaining count. An
   incomplete or unsaved transfer is never acked; the ring keeps the file.
5. On-device transcript (`MemoTranscriber`), assign to the ring's bot (default
   "Assistant", then starred, then first), and `PhoneMemos.flush` uploads with
   `watch_memo_put`; the host announces it and the bot acts on it.

Limits: the iPhone copy is the durable copy once acked (Watch-memo cap of 20
files applies). Force-quitting Swarmaa stops background wakes until reopened.
