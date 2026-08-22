# PHASE3_STEP32_REPORT.md
## PingPong — Phase 3, Step 3.2: Parallel SFU Architecture (LiveKit)

**Continuing from:** Phase 3 Step 3.1 (`VOICE_SCALING_AUDIT.md`), which was
audit-only and changed no code. This step implements that audit's
recommendation: LiveKit, as an additive, opt-in second voice provider
alongside the existing mesh path.

**Audit-before-build check performed first (per instructions):** re-read
`turn-config.js`, `voice-health.js`, `room-recovery.js`,
`voice-reconnect.js`, `callSignaling.js`, `rbac.js`, and the relevant
`server.js` wiring sections before writing any code, to confirm none of
Step 3.2's required functionality already existed. Confirmed: zero
existing SFU/media-server code or dependency anywhere in the repo
(matches the audit's own §2 finding), so nothing here duplicates prior
work.

---

## 1. Architecture

```
                 VOICE_MODE env var (default: "mesh")
                              │
                    voice_sfu/provider.js
                    getActiveProvider()
                    ┌─────────┴─────────┐
                    ▼                   ▼
             MeshProvider         SFUProvider
          (wraps turn-config.js   (wraps token.js +
           getIceServers() —      livekit.js + roomManager.js)
           byte-identical to            │
           the existing mesh            ▼
           ICE answer)             LiveKit server
                                    (separate process,
                                     self-hosted or Cloud)
```

Both providers expose the same async interface:
`getConnectionInfo({ roomId, userId, userName })`. No existing file was
changed to call this abstraction yet — see §6.

### New files (all under `voice_sfu/`, nothing existing touched to create them)

| File | Purpose |
|---|---|
| `voice_sfu/token.js` | Mints per-user LiveKit access tokens (JWT). Lazy-requires `livekit-server-sdk`; never loaded unless actually called. |
| `voice_sfu/livekit.js` | Server-admin LiveKit client (`RoomServiceClient`): create/list/delete room, list/remove participants, update metadata. Only file that ever imports `RoomServiceClient`. |
| `voice_sfu/roomManager.js` | PingPong `roomId` ↔ LiveKit room-name mapping (pure, stateless function — no table). Reuses the existing `rooms` object (read-only) to answer "is this user seated here" — the same question `relayVoiceSignal()` already asks for mesh. Local best-effort join/leave counters for the health dashboard only (never authorization). |
| `voice_sfu/provider.js` | `VoiceProvider` abstraction: `MeshProvider` / `SFUProvider`, selected fresh on every call from `VOICE_MODE`. |
| `voice_sfu/health.js` | Extends `voice-health.js` (wraps its existing `getGlobalSummary()`, does not modify it) with a second, independent SFU join/leave/error counter. |
| `voice_sfu/index.js` | `initVoiceSfu(deps)` — registers the new REST routes below. Same `init(deps)` pattern as every other module in this codebase. |

### New REST routes (all new, zero collisions — verified, see §5)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/voice-sfu/mode` | none (same trust level as `/api/calls/ice-servers`) | Tells a client the current `VOICE_MODE` and whether LiveKit env vars are set. |
| `POST /api/voice-sfu/join` | seat check via `roomManager.isUserSeatedInRoom` | Returns `{mode:'mesh', iceServers}` or `{mode:'sfu', livekitUrl, roomName, token}` depending on `VOICE_MODE`. |
| `POST /api/voice-sfu/leave` | none (bookkeeping only) | Decrements the local best-effort participant counter. |
| `GET /api/admin/voice-sfu/health` | `requireAdmin` + `voice-sfu:manage` | Combined mesh+SFU health snapshot for the admin dashboard. |
| `POST /api/admin/voice-sfu/kick` | `requireAdmin` + `voice-sfu:manage` | Force-removes a participant from the LiveKit room (moderation hook). |

---

## 2. Compatibility

- **Mesh is untouched and remains default.** `callSignaling.js`,
  `callHosting.js`, `voice-health.js`, `voice-reconnect.js`,
  `room-recovery.js`, `turn-config.js`, and `public/app.js` were **not
  modified**. The existing `voice-offer`/`voice-answer`/`voice-candidate`/
  `voice-activity` socket events, the 8-seat mesh, and
  `/api/calls/ice-servers` behave exactly as before.
- `VOICE_MODE` unset or anything other than `"sfu"` → `currentVoiceMode()`
  always resolves to `"mesh"` (fail-safe default, never fails open into
  an unconfigured SFU path).
- If `livekit-server-sdk` is not installed, `voice_sfu/index.js` still
  loads fine (the package is only `require()`'d lazily inside
  `token.js`/`livekit.js` function bodies) — `VOICE_MODE=mesh`
  deployments are 100% unaffected even with zero LiveKit setup.
- `turn-config.js` and Redis modules (`roomState.js`, `presence.js`,
  `clusterRead.js`, `socketAdapter.js`) are reused as-is, not duplicated
  — `MeshProvider` calls the real `getIceServers()`; `roomManager.js`
  reads the real `rooms` object rather than keeping its own copy.

## 3. Migration

1. Deploy this code with no env changes → no behavior change (mesh, as
   today).
2. `npm install` (picks up the new optional `livekit-server-sdk` dep;
   safe to skip if not ready — same pattern as the existing optional
   `sharp` dependency).
3. Stand up a LiveKit instance (self-hosted or LiveKit Cloud), set
   `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
4. Set `VOICE_MODE=sfu` and restart. `GET /api/voice-sfu/mode` now
   reports `sfu` + `sfuConfigured: true`.
5. **Nothing in the shipped client (`public/app.js`) calls these routes
   yet** — see §6. Step 3.2 intentionally stops at "the server-side path
   exists and works", not "users are on it."

## 4. Rollback

Set `VOICE_MODE=mesh` (or unset it) and restart — zero code rollback
needed, since mesh was never modified or removed. `voice_sfu/*` files
can also be deleted entirely and the two `require()`/init lines removed
from `server.js` with no effect on any other feature, since nothing else
imports from `voice_sfu/`.

## 5. Verification performed

- **Syntax check:** `node --check` on all 6 new files, `server.js`, and
  `rbac.js` — all pass.
- **Require-graph check:** every new `require()` path resolved via
  `require.resolve()` (`voice_sfu/*` internal requires, and
  `../turn-config.js` from `provider.js`) — all resolve.
- **Route collision scan:** grepped the entire repo for the 5 new route
  strings — each appears exactly once, only in `voice_sfu/index.js`.
- **Socket event collision scan:** this module registers zero new
  Socket.IO events (no `socket.on(...)` calls added anywhere) — nothing
  to collide with the existing `voice-offer`/`voice-answer`/
  `voice-candidate`/`voice-activity`/`voice-stats` events.
- **Permission-key collision:** `voice-sfu:manage` added to `rbac.js`'s
  `PERMISSIONS` list — confirmed exactly one occurrence, 95 total
  permission keys with zero duplicates after the add.
- **`rooms` TDZ check:** the `initVoiceSfu(...)` call was placed after
  `let rooms = {}` (line ~2277) and after `room-recovery.js`'s init call
  — not near `voice-health.js`'s earlier init block, where `rooms` would
  still be in its temporal dead zone. Verified by locating the exact
  line number of the `rooms` declaration before choosing the insertion
  point.
- **package.json validity:** parsed with `json.load()` — valid.
- **Not run (needs real infra, out of scope for a static code check):**
  an actual LiveKit server connection, token verification round-trip,
  or a real `npm install livekit-server-sdk` in this sandbox (no network
  egress available here). This is flagged, not hidden — see §6.

## 6. Honest list of what's intentionally NOT done in this step

- **No client changes.** `public/app.js` still only ever does mesh. Per
  the audit's own roadmap, wiring an SFU connection path into the
  client (single `RTCPeerConnection` instead of one per peer, LiveKit's
  client SDK) is real, non-trivial front-end work — that's **Step 3.3**,
  not 3.2.
- **No automatic hook from PingPong room lifecycle into LiveKit.**
  When a PingPong room is deleted/emptied today, nothing in this step
  calls `livekit.deleteRoom()` — `voice_sfu/livekit.js`'s `ensureRoom()`
  sets a 5-minute LiveKit-side `emptyTimeout` as a safety net instead, so
  no room can be orphaned forever, but explicit cleanup wiring is
  deferred (a one-line addition once Step 3.3 decides exactly where
  rooms get cleaned up).
- **No untested LiveKit connectivity.** This environment has no network
  egress, so the actual LiveKit REST/token calls were written against
  the documented SDK API but not executed against a live server. Treat
  `voice_sfu/livekit.js` and `voice_sfu/token.js` as needing a real
  smoke test (mint one token, join one room from a LiveKit example
  client) before Step 3.3 relies on them.
- **`npm install livekit-server-sdk` was not run** in this sandbox for
  the same no-network reason — added to `optionalDependencies` in
  `package.json` (same treatment as the existing `sharp` dependency) so
  it doesn't block anyone's install if skipped.
- **Local SFU participant counts are per-instance and best-effort**,
  explicitly not authoritative (documented in `roomManager.js`'s header)
  — a true cluster-wide count would need to call LiveKit's own
  `listParticipants()` API rather than trust local counters; deferred
  since Step 3.2 only needs "does this exist for the health dashboard",
  not a precise number.

---

## Exact file list

**Added:**
- `voice_sfu/index.js`
- `voice_sfu/token.js`
- `voice_sfu/livekit.js`
- `voice_sfu/roomManager.js`
- `voice_sfu/provider.js`
- `voice_sfu/health.js`
- `PHASE3_STEP32_REPORT.md` (this file)

**Modified (minimal, additive only — diffs are pure insertions, no line
removed or changed elsewhere):**
- `server.js` — 2 new `require()`/init lines, placed after `let rooms = {}`
  and after `room-recovery.js`'s init call.
- `rbac.js` — 1 new permission key (`voice-sfu:manage`) appended to the
  existing `PERMISSIONS` array.
- `package.json` — 1 new line, `livekit-server-sdk` added to
  `optionalDependencies`.
- `.env.example` — new `VOICE_MODE`/`LIVEKIT_*` block appended at the end,
  all commented out (no default behavior change).

**Not modified:** `callSignaling.js`, `callHosting.js`, `voice-health.js`,
`voice-reconnect.js`, `room-recovery.js`, `turn-config.js`,
`public/app.js`, and every other file in the repo.
