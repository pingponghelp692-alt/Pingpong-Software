# PHASE3_STEP33_REPORT.md
## PingPong — Phase 3, Step 3.3: Client-side SFU Integration

**Continuing from:** Phase 3 Step 3.2 (`PHASE3_STEP32_REPORT.md`), which built
the server-side SFU path (`voice_sfu/`, LiveKit provider, `/api/voice-sfu/*`
routes) but shipped no client. Per that report's §6: *"No client changes...
wiring an SFU connection path into the client is real, non-trivial front-end
work — that's Step 3.3, not 3.2."* This step is that work.

**Read-first check performed:** re-read `PHASE3_STEP32_REPORT.md` in full,
then `voice_sfu/provider.js`, `voice_sfu/index.js`, `voice_sfu/token.js`,
`voice_sfu/roomManager.js` (server side), and `public/app.js`'s mesh
implementation (`peerConnections`, `getOrCreatePeer()`, `connectToPeer()`,
`closePeer()`, `teardownVoice()`, `initMicIfNeeded()`, the `voice-activity`
VAD/UI path, and every call site that touches seat/voice state) before
writing any code. Confirmed: nothing in Step 3.2 already does client
integration (matches its own §6 finding), so nothing here duplicates prior
work.

---

## 1. What was built

Two things only:

1. **`public/voice-sfu.js`** (new file) — a self-contained module exposing
   `window.PingPongVoiceSFU = { loadSdk, connect, disconnect, isConnected }`.
   Lazy-loads the LiveKit JS client SDK from a CDN only when `connect()` is
   actually called. Wraps a single `LiveKit.Room`: publishes a given
   `MediaStreamTrack`, attaches/detaches remote audio elements on
   subscribe/unsubscribe, and forwards `ActiveSpeakersChanged` to a callback.
2. **`public/app.js`** (modified, additive only — see §4) — a `voiceMode`
   flag (`"mesh"` | `"sfu"`) fetched once per room join from the existing
   `GET /api/voice-sfu/mode`, and a small set of new functions
   (`initSfuMicIfNeeded`, `connectSfuRoom`, `teardownSfuVoice`,
   `refreshVoiceMode`) that mirror the mesh path's own functions
   (`initMicIfNeeded`, `connectToPeer`, `teardownVoice`) one-for-one, but
   talk to LiveKit instead of `RTCPeerConnection`s. Every existing mesh call
   site that would otherwise run in parallel with SFU is gated behind
   `voiceMode !== "sfu"`.
3. **`public/index.html`** (modified, 1 new `<script>` line) — loads
   `voice-sfu.js` before `app.js`, plus a cache-busting version bump on
   `app.js` (`?v=20260804c` → `?v=20260807a`), same pattern the session/auth
   stability work already established for shipping a fixed `app.js` to
   phones running a stale cached copy.

---

## 2. How mode detection and the join flow work

```
joinRoom(roomId, password)
   │
   ▼
await refreshVoiceMode()          // GET /api/voice-sfu/mode
   │
   ├─ voiceMode = "mesh" (default, or if the fetch fails) ──────────┐
   │                                                                 │
   └─ voiceMode = "sfu" (only if server reports VOICE_MODE=sfu)     │
        │                                                            │
        ▼                                                            ▼
socket.emit("join-room", ...)                          socket.emit("join-room", ...)
        │                                                            │
        ▼                                                            ▼
"room-state" / "seat-update" arrive                    "room-state" / "seat-update" arrive
        │                                                            │
        ▼                                                            ▼
initMicIfNeeded() branches on voiceMode:               initMicIfNeeded() runs the
  → initSfuMicIfNeeded()                                 ORIGINAL, unmodified mesh
    → getUserMedia (same constraints)                    code path: getUserMedia →
    → startVoiceActivityDetection()                       startVoiceActivityDetection()
      (same VAD/UI as mesh — untouched)                   → connectToPeer() for every
    → connectSfuRoom()                                     seated peer, exactly as
      → POST /api/voice-sfu/join (seat-checked              before this step existed
        server-side, per Step 3.2)
      → PingPongVoiceSFU.connect({url, token, micTrack})
        → LiveKit Room.connect() + publishTrack()
        → subscribes to remote participants' audio
```

`refreshVoiceMode()` is also called (fire-and-forget, not awaited) inside the
socket `"connect"` handler, so a refresh/reconnect that calls `rejoinRoom()`
picks up the current mode too — awaited on a *fresh* join per the spec's
explicit instruction ("At room join, call `GET /api/voice-sfu/mode`"),
fire-and-forget on a reconnect so it never adds latency to getting back into
a room after a network blip (the existing reconnect-speed work from earlier
sessions was explicitly about not adding delay there).

---

## 3. Mesh: untouched, byte-for-byte

Per the spec's "no rewrites, reuse existing architecture" instruction, this
step **never edits a mesh function's existing lines** — it only:

- Wraps 2 loop bodies that call `connectToPeer()` in an added
  `voiceMode !== "sfu"` guard (both inside `"room-state"` and `"seat-update"`
  socket handlers).
- Adds one `if (voiceMode === "sfu") { ...; return; }` short-circuit at the
  very top of `initMicIfNeeded()`'s body, before any of its original mesh
  code.
- Adds one `if (voiceMode === "sfu") teardownSfuVoice();` line at the top of
  `teardownVoice()`, before its original body (which still runs unchanged
  afterward — see below for why that's safe).
- Swaps a single `ensureLocalTracksSent();` call in the mic-toggle button
  handler for a one-line `if (voiceMode === "sfu") {...} else { ensureLocalTracksSent(); }`.

Confirmed with a line-level diff against the Step 3.2 zip's `public/app.js`:
every removed line is one of the five lines listed above being replaced by
an `if`-guarded version of itself; nothing else in the file changed. See
§7 for the exact diff summary.

**Why the unconditional parts of `teardownVoice()` and the mic-toggle
handler are safe to leave running even in SFU mode:** they only ever act on
`peerConnections` (`Object.keys(peerConnections).forEach(closePeer)`) and
`localStream`, both of which behave correctly as no-ops or shared state in
SFU mode — `peerConnections` is simply never populated there (every
`connectToPeer()` call site is gated, see above), and `localStream` is the
same `getUserMedia()` stream in both modes (see §4), so stopping its tracks
on teardown is correct either way.

---

## 4. Why speaking indicators needed almost no new code

The existing VAD path (`startVoiceActivityDetection()` → analyses
`localStream` via Web Audio → emits `socket.emit("voice-activity", ...)`)
is **not** peer-connection-specific — it runs off the local microphone
stream and reports over Socket.IO, which exists identically regardless of
whether audio itself is flowing over mesh or LiveKit. `initSfuMicIfNeeded()`
calls the exact same `startVoiceActivityDetection()` function, so:

- **Local user's own speaking ring**: works identically in both modes, zero
  SFU-specific code.
- **Remote users' speaking rings** (mesh mode): already worked via each
  remote peer's own `"voice-activity"` broadcast, received by the existing
  `socket.on("voice-activity", ...)` handler — unaffected by this step.
- **Remote users' speaking rings** (SFU mode): the same
  `socket.on("voice-activity")` path still fires (every client, mesh or
  SFU, still runs its own local VAD and still broadcasts over Socket.IO), so
  this alone would already work. `public/voice-sfu.js` additionally bridges
  LiveKit's own `ActiveSpeakersChanged` event into the exact same
  `speakingUsers`/`renderSeats()` calls, per the spec's explicit "if LiveKit
  exposes speaking events, bridge them into the existing UI" instruction —
  implemented as a second, redundant signal path, not a replacement, so a
  LiveKit-side hiccup can't stop the ring from working via the existing
  socket path.

**No UI file was touched.** `renderSeats()`, the seat markup, and
`style.css`'s speaking-ring CSS are all exactly as they were before this
step.

---

## 5. Reused, not reinvented

Per the spec's "do not invent a second reconnect system" instruction:

- **Mic capture**: `initSfuMicIfNeeded()` calls `navigator.mediaDevices.getUserMedia()`
  with the same `VOICE_AUDIO_CONSTRAINTS` object the mesh path already
  defines — not a second, SFU-specific constraints object.
- **Mic mute**: the existing `btn-mic-toggle` handler's
  `localStream.getAudioTracks().forEach(t => t.enabled = micEnabled)` line
  is completely unchanged and mutes the SFU-published track too, because
  it's the same `MediaStreamTrack` object handed to
  `room.localParticipant.publishTrack()` — muting at the WebRTC track level
  stops it being sent regardless of which transport published it. No
  SFU-specific mute API call was added.
- **Room/seat authority**: unchanged. `voice_sfu/index.js`'s
  `/api/voice-sfu/join` route (Step 3.2) already gates on
  `roomManager.isUserSeatedInRoom()`, which reads the same `rooms` object
  server.js has always owned. This step's client only ever calls that route
  once it's already seated (same seat-taken triggers as the mesh path).
- **Reconnect**: `voice-reconnect.js`, `room-recovery.js`, and
  `reconnectingPeerUserIds` are not imported, called, or duplicated by
  anything in this step. LiveKit's client SDK has its own internal
  reconnect logic for the SFU media connection (used as-is via
  `RoomEvent.Reconnecting`/`Reconnected`, logged only — see §6); this step
  does not attempt to layer PingPong's mesh-specific ICE-restart logic on
  top of it, since that logic is specifically about `RTCPeerConnection`
  pairs, which don't exist in SFU mode.

---

## 6. Logging

Added `console.log`/`console.error` only around connect / disconnect /
publish / subscribe / reconnect / failure events, in both
`public/voice-sfu.js` and the three new `app.js` functions — matching spec
requirement #10 ("no noisy logging elsewhere"). No per-frame or per-tick
logging was added anywhere (the existing mesh path's own `console.debug`
diagnostics in `startConnectionDiagnostics()` are untouched and don't apply
to SFU mode since that function is never called there).

---

## 7. Verification performed

- **Syntax check:** `node --check` on `public/app.js`, `public/voice-sfu.js`,
  `server.js`, all six `voice_sfu/*.js` files, and `rbac.js` — all pass.
- **Line-level diff against Step 3.2's `public/app.js`:** every changed hunk
  is either a pure insertion (new variables, new functions, new comments) or
  one of the exact five guarded lines described in §3 — confirmed with
  `diff`, no other line in the 6230-line file changed.
- **Route collision scan:** grepped the whole repo for
  `/api/voice-sfu/mode`, `/api/voice-sfu/join`, `/api/voice-sfu/leave`,
  `/api/admin/voice-sfu/health`, `/api/admin/voice-sfu/kick` — each still
  defined exactly once, only in `voice_sfu/index.js` (unchanged from Step
  3.2); all other occurrences are the new client code calling them.
- **Socket event collision scan:** grepped for every `socket.on(` in
  `public/app.js` before and after this step's changes — identical set,
  zero new Socket.IO event listeners were added by this step (the SFU path
  intentionally uses plain REST + LiveKit's own signaling, not Socket.IO).
- **Duplicate-implementation check:** confirmed `connectSfuRoom`,
  `initSfuMicIfNeeded`, `teardownSfuVoice`, and `refreshVoiceMode` are each
  defined exactly once in `public/app.js`; confirmed no second copy of
  `VOICE_AUDIO_CONSTRAINTS`, mic-mute logic, or a second reconnect system
  was introduced (see §5).
- **Require/script-graph check:** `public/index.html` loads
  `voice-sfu.js` before `app.js` (verified by file position); `app.js`
  references `window.PingPongVoiceSFU` only inside functions gated by
  `voiceMode === "sfu"`, never at top-level/parse time, so load order
  mistakes can't throw at page load even in mesh mode.
- **Not run (needs real infra, same limitation as Step 3.2):** an actual
  LiveKit client connection, token verification round-trip, or
  `RoomEvent`/`ActiveSpeakersChanged` behavior against a live LiveKit
  server or a real browser — this sandbox has no network egress and no
  browser. `public/voice-sfu.js` was written against the documented LiveKit
  JS SDK v2 public API (`Room`, `RoomEvent`, `Track.Source.Microphone`,
  `localParticipant.publishTrack()`, `track.attach()/detach()`,
  `room.remoteParticipants`) but is **not smoke-tested**. Flagged, not
  hidden — see §9.

---

## 8. Backward compatibility

- **`VOICE_MODE` unset or `mesh` (default):** `refreshVoiceMode()` sets
  `voiceMode = "mesh"`; every SFU-only code path in `app.js` is skipped;
  `public/voice-sfu.js` is loaded (adds one small `<script>` tag's worth of
  parse time) but never calls `loadSdk()`, so the LiveKit CDN script is
  never fetched and `window.LivekitClient` is never defined. Client
  behavior is identical to the Step 3.2 zip's client in every way.
- **LiveKit SDK unreachable / CDN blocked:** `loadSdk()`'s promise rejects;
  `connectSfuRoom()`'s `try/catch` catches it, logs, and leaves the user
  with working mic/VAD/UI but no cross-user SFU audio for that session —
  does not throw up to any caller, does not affect room join, chat, seats,
  gifts, or any other feature.
- **`GET /api/voice-sfu/mode` unreachable (older server, network blip):**
  `refreshVoiceMode()`'s `catch` sets `voiceMode = "mesh"` — the client
  behaves exactly as a pre-Step-3.3 client would.

---

## 9. Honest list of what's intentionally NOT done / NOT verified in this step

- **No real-browser / real-LiveKit-server test.** Same no-network-egress
  limitation as Step 3.2. `public/voice-sfu.js` needs one real smoke test
  (two browser tabs, `VOICE_MODE=sfu`, a real LiveKit instance) before
  production rollout — mint tokens, confirm both tabs hear each other,
  confirm `ActiveSpeakersChanged` actually fires with the shape assumed
  here.
- **No automatic fallback from SFU back to mesh mid-session.** If
  `connectSfuRoom()` fails (LiveKit unreachable, token rejected, etc.), the
  user does not get silently switched to the mesh path for that session —
  per spec requirement #9 ("never crash the room") the room, chat, and
  every other feature keep working, but that user won't exchange voice with
  others until a fresh room join succeeds. A true SFU→mesh runtime fallback
  would mean running both transports' connection logic per-peer
  simultaneously, which risks exactly the double-audio/echo problem this
  step's mode-gating exists to prevent — deferred as an explicit, separate
  future decision rather than something safe to add as a quiet extra branch
  here.
- **No admin-panel UI for SFU health.** `GET /api/admin/voice-sfu/health`
  (Step 3.2) still has no dashboard consumer — out of scope for "client-side
  SFU integration" as specified; the admin panel is a different frontend
  (`admin/`) not mentioned in this step's task.
- **Audience/non-seated listeners are not wired to SFU.** Same scope as
  Step 3.2's token minting (`canPublish: true` always) — Step 3.3 only
  handles the seated-speaker path, matching "only seated users publish
  audio" / "reuse existing room state" and not introducing new permission
  tiers.
- **LiveKit SDK version (`2.7.4`) is pinned but unverified against
  whatever LiveKit server version an operator actually deploys** — flagged
  as a pairing to confirm during the real smoke test above, not assumed
  compatible.

---

## Exact file list

**Added:**
- `public/voice-sfu.js`
- `PHASE3_STEP33_REPORT.md` (this file)

**Modified (additive only — see §3 and §7 for the exact diff shape):**
- `public/app.js` — new `voiceMode`/`sfuConnected` state, new
  `refreshVoiceMode()`/`initSfuMicIfNeeded()`/`connectSfuRoom()`/
  `teardownSfuVoice()` functions, and `voiceMode`-gated branches added at
  5 existing call sites (`initMicIfNeeded()`, the `"room-state"` handler,
  the `"seat-update"` handler in two places, `teardownVoice()`, and the
  mic-toggle button handler). No existing mesh line was removed or altered.
- `public/index.html` — 1 new `<script src="voice-sfu.js?...">` line before
  `app.js`, plus `app.js`'s cache-busting `?v=` bump (same pattern as the
  earlier session-stability fix, so phones with an old cached `app.js`
  pick up this change on next load).

**Not modified:** every server-side file from Step 3.2
(`voice_sfu/*`, `server.js`'s 2-line wiring, `rbac.js`,
`.env.example`, `package.json`), `callSignaling.js`, `callHosting.js`,
`voice-health.js`, `voice-reconnect.js`, `room-recovery.js`,
`turn-config.js`, `public/style.css`, and every other file in the repo.
