# PHASE 3 — Voice/WebRTC/LiveKit Audit — Bug #1 Found & Fixed (2026-08-11)

## Scope of this pass
Static, read-the-actual-code audit of the room-voice stack: `server.js`'s
voice signaling block, `voice_sfu/*.js` (livekit.js, token.js, sync.js,
roomManager.js, provider.js, rollout.js, health.js, index.js,
startupCheck.js), `public/voice-sfu.js`, and the relevant sections of
`public/app.js`. No dynamic/live test was possible — this sandbox has no
network egress (`npm install` returns 403, confirmed) and no reachable
LiveKit server, matching the same honest limitation already documented in
`PHASE3_STEP32_REPORT.md` §6 and `public/voice-sfu.js`'s own header
comment. Everything below was verified by reading and cross-referencing
real call sites, not assumed.

## What was already solid (verified, unchanged)
- Mesh signaling (`voice-offer`/`voice-answer`/`voice-candidate`) in
  `server.js`: correctly validates sender/target are seated in the same
  room, rate-limited, try/catch-wrapped, cluster-safe via `io.to(target)`.
- `voice_sfu/sync.js`'s `onSeatChanged` is correctly wired at all four
  claimed call sites (take-seat, leave-seat, `mod-move-seat`,
  `mod-move-to-audience`) — confirmed by grep + reading each handler.
- Token minting (`voice_sfu/token.js`) is correctly scoped, lazy-loaded,
  and never crashes a mesh-mode deployment.
- Audience SFU listening (`connectSfuAsAudience()` in `public/app.js`)
  correctly self-heals on every `room-state` sync — idempotent, guarded.

## BUG #1 (P1) — Seated speaker's LiveKit connection never recovers after a terminal disconnect

**File:** `public/app.js`
**Root cause:** `initMicIfNeeded()` starts with
`if (localStream || !mySeatNumber) return;`. This guard is correct for the
*first* connection (don't re-prompt for mic permission), but it also means
that once `localStream` exists, this function — and therefore
`initSfuMicIfNeeded()` → `connectSfuRoom()` — is **never called again for
the rest of the session**, regardless of whether the actual LiveKit `Room`
is still connected.

`public/voice-sfu.js`'s `onDisconnected` callback only does
`sfuConnected = false` — no retry, no toast, no re-join. The mic-toggle
button's own reconnect path is also gated behind `if (!localStream)`,
which is false here, so manually toggling the mic does nothing to
reconnect.

**Trigger:** any terminal LiveKit disconnect that the SDK's own internal
reconnect logic doesn't recover from. The most likely real-world case for
a live-streaming/voice-room product is the LiveKit access token's TTL
(`LIVEKIT_TOKEN_TTL_SECONDS`, default 6h — `voice_sfu/token.js`) expiring
mid-session: a long-running room (agency hosts routinely stream far longer
than 6h) hits a network blip after the token has expired, the SDK's
reconnect attempt fails auth, and LiveKit fires `Disconnected` for good.

**Symptom:** the seated user's mic UI still shows "on" (`micEnabled`,
`localStream` both still live) and they keep talking, but nobody hears
them over SFU — silently, with no error surfaced to them — until they
leave the room and re-take a seat.

**Asymmetry:** the audience path (`connectSfuAsAudience()`) already
self-heals correctly on every `room-state` sync. The seated-speaker path
had no equivalent.

**Fix (additive, one line + guard, in `public/app.js`'s `room-state`
handler, right next to the existing audience self-heal call):**
```js
if (voiceMode === "sfu" && mySeatNumber !== null && localStream && !window.PingPongVoiceSFU.isConnected()) connectSfuRoom();
```
Fires on every `room-state` sync (same trigger as the audience path).
No-ops unless: SFU mode, actually seated, mic hardware already granted
(does not force a fresh `getUserMedia` prompt), and not currently
connected. `connectSfuRoom()` itself is already idempotent
(`sfuConnected`/`isConnected()` guards), so this cannot double-connect or
double-publish.

**Not changed:** mesh mode is completely untouched (this line is gated on
`voiceMode === "sfu"`, same as every other SFU-only line in this handler).
No existing call site, function signature, or event name was modified.

**Verification performed:** read `initMicIfNeeded()`, `initSfuMicIfNeeded()`,
`connectSfuRoom()`, `connectSfuAsAudience()`, and the mic-toggle click
handler end-to-end; confirmed `window.PingPongVoiceSFU.isConnected` is
exported by `public/voice-sfu.js`. **Not verified live** (no network in
this sandbox) — needs one real test before shipping: put a seated
publisher's LiveKit token at a short TTL (e.g.
`LIVEKIT_TOKEN_TTL_SECONDS=30`), let it expire while seated, confirm the
next `room-state` broadcast reconnects them without a manual leave/rejoin.

## Not yet audited this pass (Phase 3 test list items still open)
Glare/simultaneous-offer stress test under SFU (mesh-only today, N/A to
SFU by design), 3+ simultaneous speakers under SFU, backgrounding/screen
lock behavior for the LiveKit Room object, Android WebView-specific
`getUserMedia`/autoplay quirks, TURN-only network behavior (LiveKit uses
its own internal ICE handling per `VOICE_SCALING_AUDIT.md` — not yet
independently re-verified this pass), private call/call-hosting (Phase 4,
separate 1:1 P2P surfaces, out of scope for this Phase-3-only pass).
