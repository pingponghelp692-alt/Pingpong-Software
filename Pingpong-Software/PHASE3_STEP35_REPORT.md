# PHASE3_STEP35_REPORT.md
## PingPong — Phase 3, Step 3.5: Production Rollout, Validation & Migration

**Continuing from:** Phase 3 Steps 3.1-3.4 (`VOICE_SCALING_AUDIT.md`,
`PHASE3_STEP32_REPORT.md`, `PHASE3_STEP33_REPORT.md`,
`PHASE3_STEP34_REPORT.md`). Nothing from those steps is rebuilt or
redesigned here. This step is explicitly **not** feature work — it adds
the production-hardening pieces that were genuinely missing: staged
rollout, startup validation, rollback, monitoring extensions, and
verification.

**Read-first check performed:** re-read all four prior reports and
every file under `voice_sfu/`, then `room-recovery.js` and every
`server.js` call site listed in Step 3.4's own hook table, before
writing any code.

---

## 1. What was found missing (the actual audit)

Everything Steps 3.2-3.4 built is functionally sound for the two modes
it supports (`VOICE_MODE=mesh`, `VOICE_MODE=sfu`). Three real gaps
existed for a safe production rollout:

1. **No intermediate rollout stages.** `VOICE_MODE` was a hard binary
   switch. Going from 100% mesh to 100% SFU meant flipping every user
   over in one deploy — no way to test with a small group first.
2. **A latent correctness trap if staged rollout were added naively.**
   If rollout were done **per user** instead of **per room**, two
   people in the same room could land on different transports (one on
   LiveKit, one on mesh WebRTC) and be unable to hear each other at
   all — a silent outage. This had to be designed around, not just
   implemented.
3. **No startup/config validation.** A misconfigured `VOICE_MODE=sfu`
   (missing LiveKit env vars, SDK not installed) would only surface as
   a 503 on the first real join attempt, with nothing at boot time
   telling an operator it was going to happen.

Everything else in the Step 3.5 spec (rollback, monitoring extension,
fail-safe behavior, cluster compatibility, backward compatibility) was
**already correctly built** by Step 3.4 for the mesh/sfu binary case —
this step's job for those items was mostly verification, plus closing
the same gaps for the new staged mode.

---

## 2. What was built

**New files:**
- `voice_sfu/rollout.js` — the staged-rollout decision engine.
- `voice_sfu/startupCheck.js` — non-fatal boot-time + on-demand
  readiness validation.
- `scripts/sfu-step35-verify.js` — a runnable verification/failure-
  simulation harness (see §10).

**Modified (additive only):**
- `voice_sfu/provider.js` — added `effectiveVoiceModeForRoom()` and
  `getActiveProviderForRoom()`. `currentVoiceMode()` and
  `getActiveProvider()` are byte-identical to Step 3.4.
- `voice_sfu/sync.js` — its internal gate changed from a global
  `VOICE_MODE==="sfu"` check to a per-room check (`sfuActiveForRoom`).
  Every exported function's name and call signature is unchanged.
  Also fixed `reconnectEventCount` incrementing regardless of mode
  (see §6).
- `voice_sfu/health.js` — `getCombinedHealth()`'s `voiceMode` field can
  now also read `"staged"`, with an added `rolloutConfig` field in
  that case only. Same field name, same route, no consumer exists yet
  to break (Step 3.3 already noted the admin panel wasn't extended for
  the Step 3.4 fields either).
- `voice_sfu/index.js` — `/join` and `/leave` now resolve mode
  per-room; `/mode` gained an **optional** `?roomId=` query param (the
  existing no-param response is untouched); new
  `GET /api/admin/voice-sfu/readiness` route.

**Not modified:** `server.js` (verified — see §9's diff summary; not
one line changed), `voice_sfu/token.js`, `voice_sfu/livekit.js`,
`voice_sfu/roomManager.js`, `room-recovery.js`, `public/voice-sfu.js`,
`public/app.js`, everything from Steps 3.1-3.3, and every other file
in the repo.

---

## 3. Rollout strategy (spec item 4)

`VOICE_MODE` now recognizes a third value, `staged`, alongside the
existing `mesh` (default) and `sfu`. Three independent env-var knobs
control it, evaluated as a union (a room gets SFU if it matches ANY
knob):

| Env var | Effect |
|---|---|
| `SFU_STAGE_ALLOWLIST_ROOMS` | comma-separated PingPong `roomId`s that always get SFU |
| `SFU_STAGE_ALLOWLIST_HOSTS` | comma-separated `userId`s — any room **hosted** by one of these users gets SFU (reuses the room's own existing `hostId`, no new admin/role system) |
| `SFU_STAGE_PERCENT` | 0-100 integer — that percentage of all rooms, by a stable hash of `roomId`, gets SFU |

The five spec stages are config recipes, not code branches:

| Stage | Config |
|---|---|
| 1 — 100% Mesh | `VOICE_MODE=mesh` (or unset) — today's default, unchanged |
| 2 — Internal testing | `VOICE_MODE=staged`, `SFU_STAGE_ALLOWLIST_ROOMS=<test room ids>` |
| 3 — Admin-only SFU | `VOICE_MODE=staged`, `SFU_STAGE_ALLOWLIST_HOSTS=<staff userIds>` |
| 4 — Small % rollout | `VOICE_MODE=staged`, `SFU_STAGE_PERCENT=5` (e.g.) |
| 5 — Full rollout | `VOICE_MODE=sfu` |

**Why per-room, not per-user:** the rollout decision is made once per
`roomId` (or the room's `hostId`), never per individual participant.
This guarantees every person in a given room is on the same transport
— the correctness property described in §1.2. `SFU_STAGE_PERCENT`
buckets by a stable hash of `roomId` (FNV-1a, `rollout.js`), so a given
room's answer never flaps between requests within one config, and
scaling from 5% → 25% → 100% only ever *adds* rooms to the SFU side,
never moves an already-SFU room back to mesh mid-session.

Moving between stages 2-5, or back to stage 1, requires **only an env
var change** — no code, no redeploy of client assets, no database
migration. Any stage can be entered from any other stage directly (the
knobs aren't sequential gates).

---

## 4. Production readiness validation (spec item 3)

`voice_sfu/startupCheck.js` runs once automatically when
`initVoiceSfu()` is called (server boot) and logs its findings to the
console — never throws, never exits the process, matching every other
`voice_sfu` module's fail-safe posture. It checks:

- Is `livekit-server-sdk` resolvable (`require.resolve`, no actual
  connection attempt)?
- Are `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` present
  (and does `LIVEKIT_URL` look like a `ws(s)://` URL)?
- Is `LIVEKIT_TOKEN_TTL_SECONDS` (if set) a valid positive integer?
- If `VOICE_MODE=staged`: is at least one of the three rollout knobs
  actually set? (Staged with none set is *safe* — every room falls
  back to mesh — but it's very likely not what the operator intended,
  so it's flagged as a warning, not an error.)

Behavior by mode:
- **`VOICE_MODE=mesh`** (current default): no error can be raised —
  mesh needs none of the above. If LiveKit happens to be unconfigured
  too, that's noted as an informational warning ("configure this
  before your next stage"), not a failure.
- **`VOICE_MODE=staged` or `sfu`**: missing SDK or missing env vars are
  reported as `errors` (readiness `ready: false`), because real
  traffic will actually depend on them.

The same check is re-runnable on demand via the new
`GET /api/admin/voice-sfu/readiness` route (admin-auth + `voice-sfu:manage`
permission, same gate as the existing `/health` route) — useful as a
pre-flight check before moving to the next rollout stage, without
needing server console access.

---

## 5. Rollback (spec item 5)

**Verified, not just asserted** (see §10's script, section 3):
setting `VOICE_MODE=mesh` at any stage (2 through 5) reverts every
room to mesh **instantly**, with no other change:

- `rollout.js`'s `rawBaseMode()` checks `VOICE_MODE` first, before any
  of the three staged-rollout knobs are even read.
- `provider.js`, `sync.js`, and `index.js`'s per-room resolution
  functions all funnel through that same check.
- No code rollback, no deployment rollback, no database rollback — the
  three staged-rollout env vars can be left in place (harmless) or
  removed; either way has zero effect once `VOICE_MODE=mesh`.
- Any LiveKit-side state left over from before the rollback (rooms,
  participants) is inert — mesh mode never calls into `livekit.js` or
  reads LiveKit state for anything, so nothing there can affect a
  rolled-back deployment. Those rooms will still be reclaimed by
  LiveKit's own 5-minute `emptyTimeout` (Step 3.2) if nothing else
  ever cleans them up.

This matches the spec's rollback requirement exactly.

---

## 6. Monitoring (spec item 6)

Extended (did not replace) the existing `voice_sfu/health.js`:

- `voiceMode` can now read `"staged"` in addition to `"mesh"`/`"sfu"`.
- New `rolloutConfig` field (staged mode only): counts of the
  allowlist entries and the current percent, so an operator can
  confirm the running config without reading env vars directly (no
  userIds/roomIds are echoed back — only counts, avoiding turning a
  health endpoint into a way to enumerate the allowlists).
- **Bug fixed:** `reconnectEventCount` previously incremented for
  *every* disconnect-grace-period start, regardless of `VOICE_MODE` —
  meaning even a pure-mesh deployment's SFU health panel would show a
  nonzero, meaningless reconnect count, and a staged deployment's count
  would be polluted by mesh-only rooms' reconnects. Now only counted
  for rooms actually resolved to SFU at that moment (verified in
  §10's script, section 2).
- `tokenFailureCount`, `cleanupCount`, `liveKitApiLatencyMs` (all
  Step 3.4) are unchanged and now correctly reflect only SFU-side
  rooms under staged rollout too, since they're driven by the same
  per-room-gated `sync.js` hooks.
- New `GET /api/admin/voice-sfu/readiness` route (§4) — not a metrics
  stream, but a pre-flight/config-sanity check, complementing rather
  than duplicating `/health`.

---

## 7. Failure simulation (spec item 7)

This sandbox has no network egress (same documented limitation as
Steps 3.2-3.4), so nothing here is a live LiveKit round-trip. What
*could* be verified — and was, with a real runnable script, not just
described — is everything on PingPong's side of that boundary:

| Scenario | How simulated | Result |
|---|---|---|
| LiveKit API call throws (server down, network blip, bad credentials) | Fake `livekit` client where every method throws | No exception escapes any `sync.js` function; failures land in `sfuHealth.errorCount` (§10 script, section 2) |
| Token/config failure | `startupCheck.js` against unset/partial env vars | Correctly reported as `errors`, `ready: false`, without touching the process |
| Mixed staged rollout (some rooms SFU, some mesh) | Two-room fake scenario, one allowlisted | Only the allowlisted room's hooks call LiveKit; the other room: zero calls (§10 script, section 2) |
| Rollback mid-flight | Flip `VOICE_MODE` from `staged` (100%) to `mesh` | Immediate, complete reversion, no other change (§10 script, section 3) |

**Not simulated here (needs real infra — same gap Step 3.4 already
flagged and this step does not close):** LiveKit server actually
unreachable at the network/TCP level, real token expiry/rotation
behavior against a live server, Redis reconnect during an active SFU
session, an actual multi-instance race on `onRoomPossiblyEmpty`'s
re-check. These all require a real LiveKit + Redis deployment to
exercise honestly; anything "simulated" for them without real infra
would just be re-asserting the code's own logic back at itself.

---

## 8. Cluster verification (spec item 8)

No new synchronization system was added — re-confirmed, not just
carried over from Step 3.4's own claim:

- `rollout.js` is pure and stateless — given the same `roomId`/`room`
  and the same env vars, every instance in a cluster computes the
  identical mesh/sfu answer independently. No Redis, no shared cache,
  no coordination needed for the rollout decision itself, the same
  "stateless, any instance computes the same answer" property
  `turn-config.js` and `roomManager.js` already rely on.
- `sync.js`'s per-room gate change doesn't add any new state — it
  reads the same `rooms` object (via `roomManager.getPingPongRoom`)
  every instance already has locally, plus env vars every instance
  already reads identically.
- LiveKit itself remains the single cross-instance source of truth for
  actual SFU participant state (Step 3.4's own §5 claim, unaffected by
  this step).
- `redis/roomState.js`, `redis/presence.js`, `redis/clusterRead.js`,
  the Socket.IO Redis adapter — none touched, none duplicated.

---

## 9. Backward compatibility (spec item 9) — verified via diff

Re-extracted the pristine Step 3.4 zip into a separate directory and
diffed against this step's output file-by-file (not just re-asserted
from memory):

```
Files differing: voice_sfu/health.js, voice_sfu/index.js,
                  voice_sfu/provider.js, voice_sfu/sync.js
New files:        voice_sfu/rollout.js, voice_sfu/startupCheck.js,
                  scripts/sfu-step35-verify.js
server.js:         NOT modified — zero diff
```

Every changed line is additive (new function, new optional field, new
route, or a check that was global becoming per-room while keeping
identical behavior for the non-staged case — see §2's full diffs for
each). `VOICE_MODE=mesh` (unset or explicit) and `VOICE_MODE=sfu`
behave **identically** to Step 3.4 — confirmed both by the diff review
and by the verification script's assertions (§10, sections 1-2: mesh
still means zero LiveKit calls anywhere).

---

## 10. Verification performed

- **Syntax check:** `node --check` on every file under `voice_sfu/`
  plus `room-recovery.js` and `server.js` — all pass.
- **Require-graph check:** every `voice_sfu/*.js` file, including the
  two new ones, `require()`s cleanly in isolation.
- **Route collision scan:** every `/api/voice-sfu/*` and
  `/api/admin/voice-sfu/*` route registered exactly once, all still
  only in `voice_sfu/index.js`. One net-new route this step
  (`GET /api/admin/voice-sfu/readiness`).
- **Duplicate-implementation scan:** every `sync.js` hook function,
  plus this step's new `effectiveVoiceModeForRoom`,
  `getActiveProviderForRoom`, `resolveRoomVoiceMode`, `runStartupCheck`
  — each defined exactly once. `initVoiceSfu(` / `initRoomRecovery(`
  each still called exactly once in `server.js`.
- **Diff validation:** see §9 — `server.js` has zero diff from Step
  3.4; every other changed file's diff is additive-only.
- **Existing regression suite:** `test/callSignaling.test.js` (13
  tests, untouched by this step) still passes, confirming no
  collateral effect on the unrelated calling system.
- **Functional verification script** (`scripts/sfu-step35-verify.js`,
  runnable, not just narrative) — **23/23 assertions passed**:
  - `rollout.js`: unset/mesh/sfu/garbage `VOICE_MODE` resolve
    correctly; staged mode with no knobs fails closed to mesh; room
    allowlist, host allowlist, and percent knobs each work in
    isolation; percent rollout is deterministic per room across
    repeated calls and lands within a sane range (measured 50.8% at a
    50% setting over 2000 sampled room ids) — not a hardcoded
    assertion, an actual statistical check.
  - `sync.js`: mesh mode makes zero LiveKit calls from any hook;
    staged mode only reaches LiveKit for the allowlisted room, never
    the non-allowlisted one, from the *same* `sync` instance in the
    *same* test; a LiveKit client that throws on every method never
    lets an exception escape any hook, and failures are recorded in
    `sfuHealth.errorCount`; the `reconnectEventCount` fix (§6) is
    directly verified, not just described.
  - Rollback: `staged` + 100% resolves a room to `sfu`; flipping only
    `VOICE_MODE=mesh` resolves that same room to `mesh` on the next
    call, no other state touched.
- **Not run (needs real infra, same limitation as every prior step):**
  an actual LiveKit server round-trip. Nothing in this step changes
  that limitation's scope — it was already true for `deleteRoom`/
  `removeParticipant`/`updateParticipant`/`listParticipants` before
  this step and remains true now.

---

## 11. Honest list of what's intentionally NOT done / NOT verified

- **No real-LiveKit-server test**, still — same gap every prior step
  has flagged. This step adds a config/readiness check that can catch
  *missing* config before that matters, but cannot verify a *correctly
  configured* LiveKit deployment actually works end to end. That still
  needs one real staging run with `VOICE_MODE=staged` (or `sfu`) and a
  live LiveKit instance before Stage 2 (internal testing) goes out to
  real users.
- **`SFU_STAGE_ALLOWLIST_HOSTS` reuses room hostId, not an RBAC admin
  account.** "Admin-only SFU" (spec Stage 3) is implemented as "rooms
  hosted by a userId on this list," using the same `hostId` field
  server.js already uses for in-room permissions. This was a
  deliberate choice to avoid introducing a new dependency between
  `voice_sfu/` and the RBAC admin-session system (`rbac.js`,
  `adminSessions`), which authenticates via a completely separate
  token/login flow keyed differently from a room `userId` and has no
  existing "look up RBAC role by ordinary userId" function to reuse
  without adding one. If "admin-only" is meant to specifically target
  RBAC staff accounts rather than an operator-curated userId list, that
  would need a new, explicit lookup added to `rbac.js` — not done here,
  flagged rather than guessed at.
- **`onRoomPossiblyEmpty`'s scheduled re-check is gated at schedule
  time**, using the room's mode at the moment the last user left. If an
  operator changes the rollout config in the 60-second window between
  scheduling and the re-check firing, the re-check still runs (`safe()`
  re-checks the gate again at execution time, so a room that *became*
  ineligible in that window correctly no-ops at execution) but a room
  that *became* eligible in that window will NOT get a first-time
  cleanup scheduled retroactively — it will simply get one the next
  time it empties. This is a narrow, self-healing edge case, not a
  correctness bug, and matches Step 3.4's existing acceptance of a
  fixed re-check delay as "a reasonable follow-up, not added
  speculatively."
- **No admin-panel UI** for the new `rolloutConfig` health field or the
  `/readiness` route — consistent with every prior step's own note that
  the `admin/` dashboard frontend is out of scope for a voice-
  integration step.
- **Audience/non-seated listeners still not wired to SFU** — pre-
  existing, already-flagged gap from Step 3.3, unrelated to and not
  addressed by this step.
- **Percent-rollout hashing is not cryptographic** (FNV-1a) — adequate
  for traffic-splitting, not suitable for anything security-sensitive.
  This was never a security boundary; LiveKit token minting's own
  authorization (seat-membership check) is unchanged and still gates
  who can actually get a token.

---

## Production checklist (before moving past Stage 1)

1. Provision a real LiveKit deployment; set `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. Run `npm install livekit-server-sdk` (optional dependency, already
   listed in `package.json`).
3. Check `GET /api/admin/voice-sfu/readiness` reports `ready: true`
   before changing `VOICE_MODE` away from `mesh`.
4. Stage 2: set `VOICE_MODE=staged` and `SFU_STAGE_ALLOWLIST_ROOMS` to
   one or two real internal test rooms. Verify voice actually works
   end to end against the live LiveKit instance (the one thing this
   step could not verify itself).
5. Watch `GET /api/admin/voice-sfu/health` (`sfu.errorCount`,
   `sfu.tokenFailureCount`, `sfu.liveKitApiLatencyMs`) during the test.
6. Stage 3/4: widen via `SFU_STAGE_ALLOWLIST_HOSTS` and/or
   `SFU_STAGE_PERCENT`, watching health at each step.
7. Stage 5: `VOICE_MODE=sfu`.
8. Keep `VOICE_MODE=mesh` documented as the one-line rollback at every
   stage — no other action required (§5).

---

## Exact file list

**Added:**
- `voice_sfu/rollout.js`
- `voice_sfu/startupCheck.js`
- `scripts/sfu-step35-verify.js`
- `PHASE3_STEP35_REPORT.md` (this file)

**Modified (additive only — see §2/§9 for exact diff shape):**
- `voice_sfu/provider.js` — added `effectiveVoiceModeForRoom()`,
  `getActiveProviderForRoom()`; widened `module.exports`.
- `voice_sfu/sync.js` — internal gate changed from global to per-room
  (`sfuActiveForRoom`); `reconnectEventCount` fix; no exported function
  signature changed.
- `voice_sfu/health.js` — `voiceMode` can report `"staged"`; added
  `rolloutConfig` field for that case.
- `voice_sfu/index.js` — `/join`, `/leave` resolve per-room; `/mode`
  gained an optional `?roomId=` param; new `/readiness` admin route.

**Not modified:** `server.js` (zero diff — verified), `room-recovery.js`,
`voice_sfu/token.js`, `voice_sfu/livekit.js`, `voice_sfu/roomManager.js`,
`public/voice-sfu.js`, `public/app.js`, `public/index.html`, everything
from Steps 3.1-3.3, `voice-health.js`, `voice-reconnect.js`,
`callSignaling.js`, `callHosting.js`, `turn-config.js`, every `redis/*`
file, and every other file in the repo.
