# PHASE3_STEP34_REPORT.md
## PingPong — Phase 3, Step 3.4: Server ↔ LiveKit Synchronization & Production Integration

**Continuing from:** Phase 3 Step 3.3 (`PHASE3_STEP33_REPORT.md`), which shipped
the client-side SFU path (`public/voice-sfu.js`, `app.js`'s `voiceMode`
gating). Step 3.2's server-side pieces (`voice_sfu/provider.js`,
`roomManager.js`, `livekit.js`, `token.js`, `index.js`, `health.js`) and
Step 3.3's client pieces are **not rebuilt** here — this step only wires
existing PingPong room-lifecycle events into existing SFU functions that
were previously only called per-request, on demand.

**Read-first check performed:** re-read `PHASE3_STEP32_REPORT.md` and
`PHASE3_STEP33_REPORT.md` in full, then every file under `voice_sfu/`,
`room-recovery.js`, `voice-reconnect.js`, `redis/roomState.js`, and every
call site of `handleUserLeaveRoom()`, `pendingDisconnects`, room creation
(`/api/room/create`), and room deletion (`DELETE /api/admin/rooms/:roomId`,
`close-room`) in `server.js`, before writing any code.

---

## 1. What was built

One new file, five files extended (all additive — see §7 for exact diffs):

1. **`voice_sfu/sync.js`** (new) — the orchestrator. Exposes
   `onRoomCreated`, `onRoomClosed`, `onRoomPossiblyEmpty`,
   `onParticipantLeftRoom`, `onGhostSeatCleared`, `onParticipantGraceStart`,
   `onParticipantGraceResumed`, `onSeatChanged`. Every function is a no-op
   unless `VOICE_MODE=sfu` (checked first, before any `require`/network
   work), fire-and-forget from the caller's side, and wrapped so a LiveKit
   failure can never throw into `server.js`.
2. **`voice_sfu/livekit.js`** — added `updateParticipant(roomName, identity,
   { metadata, permission })`, the one new LiveKit server-admin call this
   step needed (metadata mirror + real publish-permission enforcement).
3. **`voice_sfu/roomManager.js`** — added `getPingPongRoom(roomId)` (read-
   only accessor `sync.js` uses to re-check current state right before an
   async cleanup fires) and `clearLocalCount(name)` (bookkeeping reset after
   a LiveKit room delete).
4. **`voice_sfu/health.js`** — extended (still does not touch
   `voice-health.js`) with `tokenFailureCount`, `reconnectEventCount`,
   `cleanupCount`, and a rolling `liveKitApiLatencyMs` sample.
5. **`voice_sfu/index.js`** — creates `sync` alongside the existing
   `roomManager`/`sfuHealth`, returns it; the `/join` route's catch block
   now calls the new `recordTokenFailure()` for actual infra/config
   failures (503/500) instead of lumping them into generic `recordError()`
   (403 NOT_SEATED — a routine authorization rejection — still goes to
   `recordError()`, unchanged in kind).
6. **`room-recovery.js`** — added one optional constructor param,
   `onGhostSeatCleared(roomId, userId)`, defaulted to a no-op, called at
   the exact point the existing ghost-seat sweep already clears a seat.
7. **`server.js`** — see §2 for the exact 8 call sites wired in. Also
   reordered the `voiceSfu`/`roomRecovery` init block (`voiceSfu` now
   created first) purely so `roomRecovery`'s new hook can reference
   `voiceSfu.sync` at wiring time — no timing/behavior change to either
   module itself (both are still created once, at the same point in
   startup, before any request/socket traffic is accepted).

---

## 2. Exact hook wiring (server.js)

| PingPong event | Call site | Hook |
|---|---|---|
| Room created | `POST /api/room/create`, right after `rooms[roomId] = room` | `voiceSfu.sync.onRoomCreated(roomId)` |
| Room closed (admin) | `DELETE /api/admin/rooms/:roomId` | `voiceSfu.sync.onRoomClosed(room.roomId)` |
| Room closed (host) | `socket.on("close-room")` | `voiceSfu.sync.onRoomClosed(roomId)` |
| Any confirmed leave (explicit leave, kick, close-room member-clear, grace-period expiry) | end of `handleUserLeaveRoom()` — the ONE shared function all of those funnel through | `voiceSfu.sync.onParticipantLeftRoom(roomId, userId)` + `voiceSfu.sync.onRoomPossiblyEmpty(roomId, room.onlineUsers.length === 0)` |
| Ghost seat cleared (crash/restart recovery) | `room-recovery.js`'s existing sweep, new `onGhostSeatCleared` param | `voiceSfu.sync.onGhostSeatCleared(roomId, userId)` |
| Disconnect grace period starts | `socket.on("disconnect")`, right before `pendingDisconnects[uid] = {...}` | `voiceSfu.sync.onParticipantGraceStart(rid, uid)` |
| Disconnect grace period cancelled (user reconnected in time) | `socket.on("join-room")`, the existing `if (pendingDisconnects[userId])` block | `voiceSfu.sync.onParticipantGraceResumed(...)` |
| Seat taken | `socket.on("take-seat")` | `voiceSfu.sync.onSeatChanged(..., { canPublish: true })` |
| Seat released | `socket.on("leave-seat")` | `voiceSfu.sync.onSeatChanged(..., { seatNumber: null, canPublish: false })` |
| Seat moved (admin) | `socket.on("mod-move-seat")` | `voiceSfu.sync.onSeatChanged(..., { canPublish: true })` |
| Moved to audience (admin) | `socket.on("mod-move-to-audience")` | `voiceSfu.sync.onSeatChanged(..., { seatNumber: null, canPublish: false })` |

Every call above is a bare, un-awaited function call at an existing line —
none of them changes the return value, response timing, or emitted
socket/HTTP payload of the handler it sits in. All 8 are no-ops in mesh
mode (the default).

---

## 3. Room lifecycle synchronization (spec item 1)

- **Created:** no proactive LiveKit room creation. LiveKit room creation
  stays exactly as lazy as Step 3.2 built it (`ensureRoom()` on first
  `/api/voice-sfu/join`). Creating a LiveKit room for every PingPong room
  up front would itself risk an orphan — the many PingPong rooms that never
  use voice at all would each still leave a LiveKit room to clean up.
  `onRoomCreated` exists for symmetry/future use and currently only logs.
- **Destroyed:** `onRoomClosed` calls `livekit.deleteRoom()` immediately at
  both of this app's only two room-delete call sites. This layers on top
  of — does not replace — the 5-minute `emptyTimeout` Step 3.2's
  `ensureRoom()` already sets on every LiveKit room: if this call never
  fires (a crash mid-request), that existing timeout still reclaims it.
- **Becomes empty:** `onRoomPossiblyEmpty` schedules a single delayed
  (60s) re-check per room. At check time it re-reads the live PingPong
  room state (not the value captured when scheduled) AND calls LiveKit's
  own `listParticipants` — only deletes if BOTH report zero. This is the
  cluster-safety property from §5 below in action: a re-check against
  LiveKit's own API, not just this instance's local bookkeeping.
- **Recovers/restored:** handled by the existing lazy-creation path — a
  restarted process with `rooms.json` reloaded needs no special SFU
  handling; the first `/api/voice-sfu/join` after restart re-creates (or
  finds already-existing, since `ensureRoom` is idempotent) the LiveKit
  room exactly as it would for a brand-new room.

---

## 4. Participant synchronization (spec item 2)

- **Joins:** unchanged — `POST /api/voice-sfu/join` (Step 3.2) still
  mints the token; this step adds no new join path.
- **Leaves (any kind):** `onParticipantLeftRoom`, called once from
  `handleUserLeaveRoom()`, covers explicit leave, kick, close-room's
  member-clear, AND grace-period expiry — all in one place, since that's
  the one function all four already share. Force-disconnects the identity
  from the mapped LiveKit room so a crashed/frozen client can't keep
  publishing after PingPong itself no longer considers them in the room.
- **Reconnects / disconnect grace period:** `onParticipantGraceStart`
  tags LiveKit participant metadata (`reconnecting: true`) — it does
  **not** remove the participant, since their SFU media connection is
  independent of the Socket.IO connection that just dropped and may still
  be alive. `onParticipantGraceResumed` clears the tag if they reconnect
  in time. If the grace period instead expires, `handleUserLeaveRoom()`
  runs (as it already did) and `onParticipantLeftRoom` handles the actual
  removal — no separate "grace expired" hook was needed.
- **Recovery:** `onGhostSeatCleared`, wired through `room-recovery.js`'s
  existing sweep — see §6.
- **Forced removal:** already existed (`POST /api/admin/voice-sfu/kick`,
  Step 3.2, unchanged) for the explicit admin action; `onParticipantLeftRoom`
  adds the same effect automatically for the ordinary/kick/grace-expiry
  paths above, which previously had no LiveKit-side counterpart at all.

`room-recovery.js`, `voice-reconnect.js`, and `pendingDisconnects` are all
**reused as-is** — none of their existing detection logic, timers, or
broadcast behavior was touched. `room-recovery.js` gained one new
*optional* parameter; its ghost-detection algorithm (live socket check +
pending-grace check) is byte-identical to before.

**Honest note on `voice-reconnect.js`:** its own exported functions
(`notifyPeerDisconnecting`/`notifyPeerResumed`) were already, before this
step, never called from anywhere in `server.js` — a pre-existing gap from
whichever earlier phase built that file, unrelated to SFU. This step does
not fix that (out of scope — "only integrate," not "redesign/complete
prior phases"), and does not depend on it: `onParticipantGraceStart`/
`onParticipantGraceResumed` are wired directly off the same
`pendingDisconnects` set/clear call sites `voice-reconnect.js`'s functions
were *meant* to be called from, independently of whether that pre-existing
gap ever gets closed.

---

## 5. Seat synchronization (spec item 3)

`onSeatChanged` is called from `take-seat`, `leave-seat`, `mod-move-seat`,
and `mod-move-to-audience` — the four socket handlers that change seat
occupancy. It does two things, both read straight from the caller's
already-known seat/role state (never re-derived, never stored independently
— seat/role **authority** stays entirely in the `rooms` object, exactly as
before):

1. Mirrors `seatNumber`/`host`/`moderator`/`canPublish` into the LiveKit
   participant's metadata (informational).
2. Calls `livekit.updateParticipant(..., { permission: { canPublish, ... } })`
   — this **actually enforces** publish rights at the LiveKit layer, in
   real time, closing a gap Step 3.2 flagged but didn't handle: a token
   minted while seated always had `canPublish: true` baked in for that
   token's lifetime (see `token.js`'s comment), so a user later moved to
   audience (`mod-move-to-audience`) kept publish rights on their existing
   LiveKit connection until this step. Now their permission is
   re-asserted every time their seat status changes.

Audience members still never obtain an SFU token at all (unchanged from
Step 3.2/3.3 — `provider.js`'s `SFUProvider.getConnectionInfo` still
requires `isUserSeatedInRoom`), so "audience remains listeners" was already
true in the narrow sense that they can't publish; whether non-seated users
should be able to *subscribe* (hear) over SFU is the same pre-existing,
explicitly-flagged gap Step 3.3's report called out in its own §9 — not
addressed here, since it's a new feature (wiring audience into SFU at all),
not a synchronization fix.

---

## 6. LiveKit metadata (spec item 4)

Every `updateParticipant`/`updateRoomMetadata` call in this step's code
passes only: `pingpongRoomId`, `seatNumber`, `host`, `moderator`,
`canPublish`, `reconnecting`. No PingPong state (seat contents, user
profile fields, wallet/VIP data, room settings) is duplicated into
metadata beyond these small, derived flags — LiveKit is never treated as a
second store for anything `rooms` already owns; metadata is written, never
read back and trusted for a business decision anywhere in this codebase.

---

## 7. Cluster compatibility (spec item 5)

No new Redis-based coordination layer was added, and none was needed:
every action `sync.js` takes is a call to LiveKit's own server-admin REST
API (`RoomServiceClient`, via `livekit.js`) — LiveKit itself is a single,
external, shared source of truth across every PingPong instance, the same
role Redis plays for `rooms`/presence (see `redis/roomState.js`'s own
header). Any instance calling `deleteRoom`/`removeParticipant`/
`updateParticipant` affects the real shared LiveKit room regardless of
which PingPong process issued the call. The one place a race was possible
— an instance deleting a LiveKit room while a *different* instance's user
is still actually connected to it — is guarded in `onRoomPossiblyEmpty` by
re-checking LiveKit's own `listParticipants` (not local bookkeeping)
immediately before deleting (§3). `roomManager.js`'s `participantCounts`
remains exactly what Step 3.2 already documented it as: best-effort,
per-instance bookkeeping for the health dashboard, never a cleanup
precondition.

Building a Redis pub/sub layer for this would have been a second,
duplicate synchronization system on top of one (LiveKit's own API) that
already provides cluster-wide consistency for free — explicitly avoided
per the spec's "no duplicate implementations" rule.

---

## 8. Health monitoring (spec item 6)

`voice_sfu/health.js` (extended, `voice-health.js` untouched) now tracks,
in addition to its existing `joinCount`/`leaveCount`/`errorCount`/
`activeLocalRooms`/`recentEvents`:

- `tokenFailureCount` — LiveKit-not-configured / SDK-missing / mint
  errors from `/api/voice-sfu/join`, separated from routine 403
  not-seated-yet rejections.
- `reconnectEventCount` — incremented once per `onParticipantGraceStart`
  call, the SFU-side echo of the count mesh already tracks in
  `voice-reconnect.js`.
- `cleanupCount` — incremented once per successful automatic LiveKit room
  deletion (`onRoomClosed` or `onRoomPossiblyEmpty`).
- `liveKitApiLatencyMs` — `{ avg, lastSampleCount }` over a bounded
  rolling sample of every timed LiveKit API call `sync.js`'s `safe()`
  wrapper makes (join/leave counts were already tracked separately in
  `index.js`'s own routes and are not double-counted here).

All of it surfaces through the existing `GET /api/admin/voice-sfu/health`
route (unchanged route, unchanged permission gate) via the existing
`getCombinedHealth()`/`getSfuSummary()` functions, extended in place.

---

## 9. Automatic cleanup (spec item 7)

Covered by `onRoomClosed` (immediate, on explicit close) and
`onRoomPossiblyEmpty` (delayed, re-verified, on the last user leaving) —
see §3. Both call `roomManager.clearLocalCount()` afterward so the local
bookkeeping `health.js`'s `activeLocalRooms` reads from can't show a
phantom room after LiveKit's copy is actually gone.

---

## 10. Fail-safe behaviour (spec item 8)

Verified directly (see §11's smoke test): every `sync.js` function is
wrapped in a `try/catch` (`safe()`) that logs and records the failure via
`sfuHealth.recordError()`/`recordApiLatency()` but never re-throws. A
LiveKit outage means `sync.js`'s calls fail silently (logged) — it cannot
throw into `handleUserLeaveRoom()`, the `take-seat`/`leave-seat` handlers,
the room-create/close routes, or the disconnect handler, all of which
would otherwise take down the process or corrupt in-memory room state on
an uncaught exception. Mesh mode is completely unaffected regardless
(every function checks `VOICE_MODE` first, before doing anything else).

---

## 11. Verification performed

- **Syntax check:** `node --check` on `server.js`, `room-recovery.js`, and
  every file under `voice_sfu/` — all pass.
- **Require-graph check:** every `voice_sfu/*.js` file (including the new
  `sync.js`) `require()`s cleanly in isolation with no circular-import or
  missing-module errors.
- **Route collision scan:** grepped for every `/api/voice-sfu/*` and
  `/api/admin/voice-sfu/*` route across the whole repo — each still
  registered exactly once, only in `voice_sfu/index.js`; no new routes
  were added by this step.
- **Socket event collision scan:** grepped for `take-seat`, `leave-seat`,
  `mod-move-seat`, `mod-move-to-audience`, `close-room`, `join-room`,
  `disconnect` — each still registered exactly once; this step only added
  code *inside* existing handlers, never a second `socket.on(...)` for any
  of them.
- **Duplicate-implementation check:** every new function
  (`onRoomCreated`, `onRoomClosed`, `onRoomPossiblyEmpty`,
  `onParticipantLeftRoom`, `onGhostSeatCleared`, `onParticipantGraceStart`,
  `onParticipantGraceResumed`, `onSeatChanged`) is defined exactly once, in
  `sync.js`; `initRoomRecovery(` and `initVoiceSfu(` are each still called
  exactly once in `server.js`.
- **Line-level diff against the Step 3.3 zip:** every line `diff` reports
  as *removed* is one of: (a) the `voiceSfu`/`roomRecovery` init block
  being moved (not changed — identical lines, new position), (b) a
  `module.exports`/return-statement widened to include a new export, or
  (c) `room-recovery.js`'s ghost-seat-userId capture rewritten from an
  inline `seat.userId` read to a `ghostUserId` local (functionally
  identical — `seat` still refers to the same object after
  `room.seats[i] = null`, this only makes the new hook call read clearly).
  No existing line of actual business logic was altered or deleted
  anywhere in the diff.
- **Reconnect/recovery flow smoke test (in-process, no live LiveKit):**
  scripted calls to every `sync.js` function against a fake `livekit`
  object confirmed (a) zero LiveKit calls in mesh mode, (b) the exact
  expected call shape in SFU mode for room-close, participant-leave,
  ghost-seat, grace-start/resume, and seat-change, and (c) `sfuHealth`'s
  new counters increment correctly.
- **Fail-safe smoke test:** the same functions called against a `livekit`
  object where every method throws confirmed zero exceptions propagate out
  of any `sync.js` function, and `errorCount` increments correctly instead.
- **Not run (needs real infra, same limitation as Steps 3.2/3.3):** an
  actual LiveKit server round-trip for `deleteRoom`/`removeParticipant`/
  `updateParticipant`/`listParticipants` — this sandbox has no network
  egress. `livekit.js`'s `updateParticipant` was written against the
  documented `RoomServiceClient` API shape (positional `metadata` string +
  `permission` object, mirroring the SDK's own `updateRoomMetadata`
  pattern already used elsewhere in that file) but is **not
  smoke-tested against a live LiveKit instance**. Flagged, not hidden.

---

## 12. Backward compatibility

- **`VOICE_MODE` unset or `mesh` (default):** every one of the 8 new call
  sites in `server.js` reaches `sync.js`, whose every function returns
  immediately on the `VOICE_MODE !== "sfu"` check, before requiring or
  calling `livekit.js` at all. Timing, control flow, return values, and
  emitted events at every touched handler are unchanged from the Step 3.3
  zip. `room-recovery.js`'s ghost sweep behaves identically (its new
  parameter defaults to a no-op).
- **LiveKit unreachable while `VOICE_MODE=sfu`:** every `sync.js` call
  fails safely (logged, recorded, never thrown) — room/seat/leave/
  disconnect logic in `server.js` completes exactly as it would with
  LiveKit healthy; only the LiveKit-side mirror falls behind (and
  `sfuHealth.errorCount`/`liveKitApiLatencyMs` reflect that for anyone
  looking at `/api/admin/voice-sfu/health`).

---

## 13. Honest list of what's intentionally NOT done / NOT verified

- **No real-LiveKit-server test** for any of this step's new calls
  (`deleteRoom`, `removeParticipant`, `updateParticipant`,
  `listParticipants` in the empty-room re-check) — same no-network-egress
  limitation as Steps 3.2/3.3. Needs one real smoke test (a live LiveKit
  instance, `VOICE_MODE=sfu`, exercise take-seat/leave-seat/close-room/
  kick/disconnect against it) before production rollout.
- **Audience/non-seated listeners are still not wired to SFU at all** —
  same pre-existing, already-flagged gap from Step 3.3 (§9 there). Seat
  synchronization in this step makes publish-permission revocation correct
  for users who *were* seated and then aren't, but doesn't add SFU
  subscribe-only access for audience members who were never seated.
- **`voice-reconnect.js`'s own `notifyPeerDisconnecting`/
  `notifyPeerResumed` functions remain uncalled** from anywhere in
  `server.js` — a pre-existing gap unrelated to SFU (see §4's honest
  note), not fixed here since it's outside this step's stated scope.
- **`onRoomPossiblyEmpty`'s 60-second re-check delay is a single fixed
  constant**, not configurable via an env var the way
  `LIVEKIT_TOKEN_TTL_SECONDS` (Step 3.2) is — flagged as a reasonable
  follow-up, not added speculatively here.
- **No admin-panel UI change** for the new `tokenFailureCount`/
  `reconnectEventCount`/`cleanupCount`/`liveKitApiLatencyMs` fields — they
  exist in `GET /api/admin/voice-sfu/health`'s JSON response (same route,
  unchanged) but the `admin/` dashboard frontend was not touched to
  display them, matching Step 3.3's own note that the admin panel is a
  separate frontend out of scope for a voice-integration step.

---

## Exact file list

**Added:**
- `voice_sfu/sync.js`
- `PHASE3_STEP34_REPORT.md` (this file)

**Modified (additive only — see §7/§11 for exact diff shape):**
- `voice_sfu/livekit.js` — added `updateParticipant()`, widened
  `module.exports`.
- `voice_sfu/roomManager.js` — added `getPingPongRoom()`,
  `clearLocalCount()`, widened return object.
- `voice_sfu/health.js` — added `tokenFailureCount`, `reconnectEventCount`,
  `cleanupCount`, `liveKitApiLatencyMs` and their recorder functions;
  widened return object; `voice-health.js` untouched.
- `voice_sfu/index.js` — creates and returns `sync`; `/join` route's catch
  block now distinguishes token/infra failures from routine 403s.
- `room-recovery.js` — added optional `onGhostSeatCleared` param
  (defaults to no-op), one new call site inside the existing sweep loop.
- `server.js` — reordered the `voiceSfu`/`roomRecovery` init block
  (identical code, new position); added the 8 hook calls listed in §2, all
  single-line additions at existing call sites; no existing line removed
  or altered outside of what's described above.

**Not modified:** everything from Steps 3.1–3.3
(`public/voice-sfu.js`, `public/app.js`, `public/index.html`,
`voice_sfu/provider.js`, `voice_sfu/token.js`, `rbac.js`, `.env.example`,
`package.json`), `voice-health.js`, `voice-reconnect.js`,
`callSignaling.js`, `callHosting.js`, `turn-config.js`, every `redis/*`
file, and every other file in the repo.
