# GAP #2 + GAP #3 — Delivery Report
Redis Authoritative Runtime State — continuation session

## Status

- **GAP #2 (Cross-Instance Room Operation Forwarding): PARTIAL — the 3 named ops are done.** `take-seat`, `leave-seat`, `send-message` now forward correctly to the owning instance. Other owner-dependent room operations were audited but **not yet forwarded** (list below) — they keep their pre-existing single-instance-only behavior.
- **GAP #3 (Two-Node Cluster Validation): COMPLETE** for what could be tested in this sandbox (no real second OS process / real Redis available — same constraint documented by every existing `test/*.js` in this repo). A realistic two-node simulation was built and exercises the **real** `redis/*.js` modules, not re-implementations.
- Original regression: 126/126 (from GAP #1)
- **New total regression: 172/172 pass** (126 existing + 19 new `roomOpRpc.test.js` + 27 new `twoNodeCluster.test.js`)
- No architecture migration started. No previously completed code was rewritten — only the 3 named handlers were refactored (extracted, not rewritten) to share one mutation function between the local and cross-instance path, the same pattern GAP #1's `performRoomJoin`/`roomJoinRpc.js` already established.

---

## GAP #2 — what was actually broken

Once GAP #1 let a user join a room owned by a *different* cluster instance, every subsequent room-mutating event on the instance actually holding that user's socket hit:
```js
const room = rooms[roomId];
if (!room) return; // silent no-op — room genuinely isn't on this instance
```
`take-seat`, `leave-seat`, and `send-message` simply did nothing for such a user. Chat, seating, and the AI moderation/assistant pipeline all silently broke for anyone in a cross-instance room.

## GAP #2 — what was built

**`redis/roomOpRpc.js`** (new) — generalizes `roomJoinRpc.js`'s pattern from "one operation" to "any owner-dependent operation":
- Same `pubsub.on("room", ...)` channel, two new event names (`op-request`/`op-response`) alongside the existing `join-request`/`join-response`.
- `registerOp(opName, performerFn)` — a `Map<opName, fn>` instead of one hardcoded function, so forwarding another operation later is a one-line registration, not a new RPC module.
- Same safety contract as `roomJoinRpc.js`: Redis disabled / publish failure / no answer / unknown op on the receiving side all resolve to a clean `{ ok: false, error }`, never a throw or a hang. `RPC_TIMEOUT_MS = 4000`, same as the join RPC.

**`server.js`** — extracted the *exact* existing statements from the three handlers into three shared functions (`performTakeSeat`, `performLeaveSeat`, `performSendMessage`), placed next to `performRoomJoin` and registered with `roomOpRpc`. Each socket handler now does:
```js
const room = rooms[roomId];
if (room) { /* local path — byte-for-byte the old logic, now via the shared fn */ }
else { roomOpRpc.forwardOp(opName, roomId, payload).then(...); } // NEW
```
One real fix found along the way, not scope creep: the AI-moderation "kick" branch inside `send-message` used to look up `socketsByUserId[socket.userId]` (local-instance-only) to force the target's raw socket to `.leave()` the room. That breaks the moment the function runs on the *owning* instance for a user connected elsewhere. Replaced with Socket.IO's own cluster-aware `io.in(\`user:${userId}\`).socketsLeave(roomId)` — adapter-safe, and an exact no-op-equivalent for a single-instance deployment (no behavior change there).

### Explicitly audited but NOT forwarded this pass
`leave-room` (`handleUserLeaveRoom`), `lock-seat`, `set-room-lock`, `kick-user`, `set-admin`, `mod-mute-users`, `mod-chat-ban`, `mod-invite-to-seat`, `mod-move-seat`, `mod-move-to-audience`, `mod-label-users`, `mod-announce-users`, `close-room`, `clear-chat`, `update-room-background/logo`, `music-update`, all `yt-*` handlers, `game-toggle`, `game-wheel-sync`, `send-gift`/`send-video-gift`, `fruitwheel-*`, `send-emoji-reaction`, `voice-activity`. These all have the same `if (!room) return` shape and are candidates for the same `registerOp(...)` treatment in a follow-up pass — `leave-room` is the highest-priority one (it's the natural lifecycle complement of `leave-seat`, but it also mutates socket-local state — `socket.leave()`, `socketsByUserId` — that needs to be split from the room-mutation part before it can be forwarded cleanly, which is more involved than the three ops done here).

---

## GAP #3 — two-node cluster validation

No real second OS process or real Redis was available (this sandbox has no network egress). Built `test/twoNodeCluster.test.js`: an in-memory fake Redis **server** (get/set/del/hset/hgetall/expire/sadd/srem/smembers/mget/scan/multi/pipeline/publish/subscribe), then two independently, freshly-`require()`'d copies of every relevant real module (`pubsub.js`, `sessionStore.js`, `roomState.js`, `userState.js`, `presence.js`, `roomJoinRpc.js`, `roomOpRpc.js`) — one "as Node A", one "as Node B" — each with its own `INSTANCE_ID` (faked `os.hostname()` per load) and its own closures, sharing the one fake Redis server exactly like two real processes would share one real Redis. **Every module under test is the real file** — nothing is reimplemented, same technique already established by `test/roomJoinRpc.test.js`.

27 assertions across:
1. Login/session — session created on A, validated + touched from B
2. Room create/join — cross-instance join from B into a room only A has
3. Seat — take-seat from B applied to A's real room
4. Message — send-message from B lands in A's real chat log
5. Leave — leave-seat from B frees the real seat on A
6. Presence — status computed/written by A read correctly from B
7. Cross-instance notifications — pub/sub delivery + correct instance attribution
8. Reconnect — rejoining from B after a session move preserves all prior room state (chat history, socketId update)
9. Room state consistency — A's `roomState.js` mirror snapshot read correctly from B, including cluster-wide `listRoomIds()` discovery
10. Redis outage — every path above degrades to a clean `{ ok: false }` / `null`, never a throw or hang

All 27 pass.

---

## Files changed

| File | Change |
|---|---|
| `redis/roomOpRpc.js` | **New.** Generalized cross-instance room-operation RPC (GAP #2). |
| `server.js` | Extracted `performTakeSeat`/`performLeaveSeat`/`performSendMessage`; wired `roomOpRpc` init + `registerOp` calls; `take-seat`/`leave-seat`/`send-message` handlers now branch local vs. cross-instance-forward; AI-moderation kick uses cluster-safe `socketsLeave`. |
| `test/roomOpRpc.test.js` | **New.** 19 assertions, unit-level RPC correctness for GAP #2. |
| `test/twoNodeCluster.test.js` | **New.** 27 assertions, GAP #3 two-node validation. |

## Tests

```
node test/*.test.js   (all 13 files)
172/172 pass, 0 failed
```

## Blockers / honest remaining work

1. **~40 other owner-dependent room handlers are not yet cross-instance-safe** (listed above) — same `if (!room) return` gap as GAP #2 fixed for 3 of them. Recommend forwarding `leave-room` next (needs the local/remote split described above), then the `mod-*` moderation actions.
2. **GAP #3 validation is simulation-level, not a real two-process/real-Redis run.** No real Redis server or second OS process was reachable in this sandbox — this matches the constraint every existing test file in the repo already documents (see `test/roomJoinRpc.test.js`'s own header). Before production rollout, the same scenario script should be re-run against two actual `node server.js` processes pointed at one real Redis, to catch anything a fake Redis/fake adapter can't (real network latency, real ioredis reconnect behavior, real `@socket.io/redis-adapter` room-membership sync).
3. Per the instructions for this session, GAP #4 was not started.
