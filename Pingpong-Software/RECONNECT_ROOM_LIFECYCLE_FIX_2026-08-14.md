# PingPong — Reconnect / Duplicate join-room / Room Lifecycle — Root-Cause Fix Report

Date: 2026-08-14
Scope: server.js (Socket.IO room join/leave/disconnect lifecycle), public/app.js (client join lifecycle)

This responds to the production log showing the same user repeatedly cycling
through `join-room` → `Disconnect` → `reconnected before grace period expired`
→ `Owner ... is now offline` → `User ... left room` → `join-room`, duplicate
`join-room` from the same socket.id, and rapid `276bdade7b ↔ 101` room
switching. Every fix below is a real lifecycle/logic change — nothing here
suppresses a log line, blindly extends a timeout, or adds an arbitrary delay.

---

## 1. Exact root cause(s)

**(a) No server-side join idempotency.** `join-room` re-ran the entire join
mutation and its side effects (`room-state`/`user-count` broadcast, global
`room-list` broadcast, recent-room-visit recording, follow-status broadcast,
vehicle-entry broadcast) every single time the same socket sent it — even for
a room it was already fully joined to. A duplicate emit from the same
socket.id multiplied all of that room-wide traffic instead of being a no-op.

**(b) Stale room joins on room switch (the primary cause of the
`276bdade7b ↔ 101` flapping).** Neither the client nor the server ever left
the OLD room before joining a NEW one. `public/app.js`'s `joinRoom()` simply
overwrote `currentRoomId` and emitted `join-room` for the new room; the server
mirrored that by overwriting `socket.currentRoom` in `finishJoin()` with no
cleanup of the old room's `onlineUsers`/seat entry. The old room kept the user
"present" indefinitely — visible in the log as the user seeming to be in two
rooms and periodically getting removed from one or the other.

**(c) No client-side join guard.** There was no `joinInProgress`/
`joinedRoomId` state at all, so a double-tap on a room card, or a client-side
reconnect race, could fire two overlapping `join-room` emits with nothing to
serialize them.

**(d) Grace-period race protection relied on a single signal.** The
disconnect grace-period timers (room-seat and no-room presence) only checked
`socketsByUserId[uid] !== socket.id` before deciding whether to act. That is
usually correct, but it is one mutable slot with no independent confirmation
that the timer is still acting on the exact connection instance it was
scheduled for.

**(e) Seat freeing was keyed only on `userId`, not on seat ownership.** A
stale disconnect-grace timer freed *any* seat matching the user's `userId`,
regardless of whether a newer socket/session had already re-taken that exact
seat.

**(f) Owner "offline" flapping** was a downstream symptom of (b) + (c): rapid
duplicate join/leave cycles for the same user (bouncing between local
join/leave state without ever cleanly resolving) triggered `handleUserLeaveRoom`
repeatedly, which logs `Owner ... is now offline` every time it runs for the
host — even though `room.hostId` itself was never actually reassigned
(permanent-ownership behavior from the 2026-07-27 fix was already correct and
untouched here).

**Not a root cause:** Voice/SFU. `public/voice-sfu.js` runs its own,
independent LiveKit `Room` instance and never touches `window.socket` (the
main Socket.IO connection) in any code path — connect, disconnect, reconnect,
or publish/unpublish. It was already correctly decoupled from the main
Socket.IO connection per requirement #8; no change was needed there.

---

## 2. Exact files changed

- `server.js`
- `public/app.js`
- `test/joinRoomLifecycleFix.test.js` (new regression test)

`public/voice-sfu.js` — audited, unchanged (already correctly isolated).

---

## 3. Exact functions changed

**server.js**
- New: `bindSocketToUser(socket, userId)` — single place `socketsByUserId[userId]`
  is now ever assigned; also tracks connection generation.
- New module-level state: `userConnGeneration` (userId → integer, bumped every
  time a *different* socket becomes current for that user).
- `io.on("connection", ...)` → `socket.on("identify", ...)` → `finishIdentify()`:
  now calls `bindSocketToUser()` instead of a bare assignment.
- `socket.on("join-room", ...)`:
  - added duplicate-join short-circuit (idempotency).
  - added old-room cleanup via `handleUserLeaveRoom()` before a room switch.
  - added `socket._joinSeq` sequencing token.
  - `finishJoin()` now calls `bindSocketToUser()` instead of a bare assignment.
  - cross-instance RPC `.then()`/`.catch()` callbacks now check `socket._joinSeq`
    before acting, discarding stale results.
- `handleUserLeaveRoom(roomId, userId, socket, isDisconnecting)`:
  - added a top-of-function guard rejecting stale `isDisconnecting=true` calls.
  - seat-freeing loop now verifies `seat.socketId === socket.id` before
    freeing a seat when `isDisconnecting` is true.
- `socket.on("disconnect", ...)`:
  - both the room-seat grace timer and the no-room presence grace timer now
    capture `socket.connGen` at schedule time and compare it against the
    live `userConnGeneration[uid]` before acting, in addition to the
    existing `socketsByUserId` check.

**public/app.js**
- New global state: `joinedRoomId`, `joinInProgress`, `pendingJoinRequest`.
- `joinRoom(roomId, password)`: no-ops a duplicate tap for an already-joined
  room; queues (last-write-wins) a request if a join is already in flight
  instead of emitting immediately.
- `rejoinRoom()`: always resets `joinedRoomId` (a reconnect always gets a new
  server-side socket.id, so any previous ack is stale) and is guarded by the
  same `joinInProgress`/`pendingJoinRequest` mechanism.
- `socket.on("room-state", ...)`: now the single place that marks a join as
  actually complete (`joinedRoomId`, `joinInProgress = false`) — driven by the
  server's acknowledgement, not set optimistically at emit time. Dispatches
  any queued room-switch request once the in-flight join settles.
- `socket.on("room-error", ...)`: clears `joinInProgress` (previously nothing
  did, so a rejected join would permanently wedge the guard) and drains the
  pending-request queue.
- `btn-leave-room` click handler, `socket.on("kicked", ...)`,
  `socket.on("room-error", ...)` (gone/locked-room branch), and
  `btn-mod-close-room` click handler: all four `currentRoomId = null` reset
  sites now also reset `joinedRoomId`/`joinInProgress`/`pendingJoinRequest`
  so the guards never leak stale state across a real room exit.

---

## 4. Why duplicate "join-room" was happening

Two independent causes, both now closed:
- The client had no guard at all against sending `join-room` twice for the
  same room (double-tap, or a reconnect racing an in-flight join) — fixed by
  `joinInProgress`/`joinedRoomId` on the client.
- The server had no idempotency check, so even a legitimate duplicate (e.g. a
  slow network causing the client to retry) fully re-ran the join and all its
  broadcast side effects — fixed by the `socket.currentRoom === roomId` short
  circuit in the `join-room` handler.

## 5. Why reconnect was happening

The 8–10 reconnects/300s pattern in the log is consistent with genuine
transport-level reconnects (already mitigated by the existing fast/persistent
`reconnectionDelay` config and the Android foreground voice service from
Phase 3) compounding with the room-switch bug (b): every reconnect's `connect`
handler calls `rejoinRoom()`, and because the client never left its old room
first, each cycle left additional stale state behind in whichever room wasn't
the "current" one, producing log noise that looked like more reconnect/rejoin
churn than the underlying transport actually had. No duplicate Socket.IO
initialization or duplicate `connect` listener was found — `connectSocket()`
is correctly guarded by `if (socket) return`.

## 6. Why owner was repeatedly becoming offline

`room.hostId` itself was never reassigned (the 2026-07-27 permanent-ownership
fix was correct and is untouched). The repeated `"Owner ... is now offline"`
log lines were `handleUserLeaveRoom` being invoked repeatedly for the host
user as a downstream symptom of the duplicate-join/stale-room-switch bugs
above — fixing (a) and (b) removes the repeated invocations, so this log line
will now only appear when the host's connection genuinely and fully drops.

## 7. Whether seat state could be corrupted

Yes — confirmed possible before this fix: `handleUserLeaveRoom`'s seat-freeing
loop matched purely on `userId`, so a stale disconnect-grace timer could free
a seat that a newer socket/session of the same user had already re-taken.
Closed by the seat-ownership check (`seat.socketId === socket.id`) added to
that loop, plus the top-of-function stale-call guard and the connection-
generation check in the grace timers themselves (three independent layers).

## 8. Whether SFU voice was contributing to the reconnect

No. Audited `public/voice-sfu.js` in full — it never calls `socket.disconnect()`,
never re-emits `join-room`/`leave-room`, and maintains its own LiveKit `Room`
object entirely independently of `window.socket`. Its own `Reconnecting`/
`Reconnected`/`Disconnected` handlers only log and manage its own `currentRoom`
reference. Requirement #8 ("voice reconnect must not trigger the app socket to
reconnect") was already satisfied by the existing code; no change was needed.

## 9. Tests executed and results

Full existing regression suite (`npm test`, dependency-free, no `node_modules`
needed since every suite is written to run without express/socket.io actually
installed):

```
Suites: 28/28 passed
```

(27 pre-existing suites, all still passing unchanged, plus the new
`test/joinRoomLifecycleFix.test.js`, 31/31 assertions passing.)

The new suite follows the same honest pattern already established by
`test/roomStateJoinRace.test.js` for this codebase: structural checks against
the real, currently-committed `server.js`/`public/app.js` source (so a future
revert of any of these fixes fails the test against the real file, not a
mock), covering:
- server-side join idempotency
- old-room cleanup ordering on room switch
- the join-sequencing token discarding stale cross-instance RPC responses
- connection-generation tracking wired into both grace-period timers
- seat-ownership verification ordered correctly before freeing a seat
- client-side join guards and the server-ack-driven join-completion signal

`node --check server.js` and `node --check public/app.js` both pass.

**Not executed (no live environment / no network egress in this sandbox):**
a live 15-scenario manual run (rapid reconnect ×10, rapid room switching,
double-click room entry, etc.) against a running server + real Socket.IO
client. The structural/behavioral tests above guard the fix at the source
level; a live pass through the 15 scenarios listed in the original request is
recommended before this is considered fully production-verified, the same
caveat already flagged for Phase 3's live-device testing.

## 10. Any remaining risk

- The live-scenario validation list (all 15 items in the original request) has
  not been exercised against a running server in this sandbox — recommend
  running it once against staging before relying on this in production.
- `handleUserLeaveRoom`'s new seat-ownership guard only applies when
  `isDisconnecting === true` (grace-timer path) — this is intentional (an
  explicit, live `leave-room` from the user's own current socket should
  always free whichever seat that user currently holds), but is worth
  re-confirming against real traffic.
- Connection-generation tracking (`userConnGeneration`) is in-memory only,
  same lifetime/scope as `socketsByUserId` and `pendingDisconnects` — it does
  not survive a server restart, which is consistent with the rest of this
  module's existing state model and not a new limitation introduced here.
- The client-side `pendingJoinRequest` queue keeps only the single most recent
  request (by design — "only the latest requested room should become
  authoritative"); if a user rapid-fires more than two rooms, only the very
  last tap is ever dispatched, intermediate ones are silently dropped (this is
  the correct, intended behavior per requirement #6, flagged here so it's not
  mistaken for a bug if noticed in testing).
