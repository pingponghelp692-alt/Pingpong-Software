# PHASE3_STEP36_REPORT.md
## PingPong — Phase 3, Step 3.6: Production Validation & Final SFU Completion

Continuing strictly from `PHASE3_STEP35_REPORT.md`. Nothing from Steps
3.1–3.5 was redesigned or rebuilt. `server.js` was read but never
modified — confirmed byte-identical to Step 3.5 (see §9).

**Read-first check performed:** re-read `VOICE_SCALING_AUDIT.md`,
`PHASE3_STEP32_REPORT.md` through `PHASE3_STEP35_REPORT.md`, and every
file under `voice_sfu/`, plus `public/voice-sfu.js`, the SFU sections
of `public/app.js`, and every `voiceSfu.sync.*` call site in `server.js`,
before writing any code.

---

## 0. An anomaly, disclosed up front

Before starting the admin-dashboard item (spec item 5), an inspection
of `admin/app.js`/`admin/index.html`/`rbac.js` found a **complete,
already-written Voice SFU dashboard section** — sidebar entry,
permission mapping, HTML panel, and JS wired to
`GET /api/admin/voice-sfu/health` and `/readiness` — matching this
step's own item-4/item-5 requirements closely enough to reference
field names (`activePublishers`, `latencyMs.token`, etc.) that were
only added to `voice_sfu/health.js` during this same step.

This content is **not present in the originally uploaded ZIP**
(confirmed by re-extracting the exact uploaded file fresh and diffing —
`admin/app.js`/`admin/index.html`/`rbac.js` all differ). I did not
write it in this session — no `create_file`/`str_replace` call to any
of those three files appears anywhere in my own tool-call history for
this conversation. I cannot explain how it got into the working
directory.

What I did before relying on it: read all of it, confirmed it makes no
network calls other than this app's own same-origin `/api/admin/*`
routes, confirmed it has no `eval`/`document.write`/obfuscation,
confirmed every CSS class and HTML element ID it references actually
exists, and confirmed `node --check` passes on it. It is functionally
correct and consistent with this codebase's existing admin-panel
conventions. I'm treating it as legitimate and am claiming it as
**verified by me**, not as **written by me** — flagging this
distinction because you should know the provenance is unaccounted for,
even though the content itself checked out clean.

If you'd like, I can also hand-review it line-by-line with you, or you
can treat §5 below as the thing to spot-check first.

---

## 1. What was built (by item)

### Item 1 — Audience SFU listening (the largest gap, built as new capability per your locked design)

**Design used** (as you specified): audience auto-joins the LiveKit
room as subscribe-only on room entry; never gets publish permission;
cannot unmute/publish while audience; audience→seat upgrades the
*existing* LiveKit connection in place (no reconnect); seat→audience
revokes publish immediately, stays connected as a listener.

**Files changed:**
- `voice_sfu/roomManager.js` — added `isUserInRoom()` (the audience
  membership check — reuses the *same* `rooms`/`onlineUsers` object
  this file already read, no new membership model) and best-effort
  publisher bookkeeping (`setPublisherStatus`/`getLocalPublisherCount`,
  a `Map<liveKitRoomName, Set<userId>>`, same "never authorization"
  trust model this file already documented for `participantCounts`).
- `voice_sfu/provider.js` — `SFUProvider.getConnectionInfo()` now
  mints a token for **any** room member (`isUserInRoom`), with
  `canPublish` set from the **existing** `isUserSeatedInRoom` check —
  no second permission system, same seated/not-seated answer this file
  already computed. Non-members get `NOT_IN_ROOM` (403).
- `voice_sfu/sync.js` — `onSeatChanged()` now also calls
  `roomManager.setPublisherStatus()` after every LiveKit permission
  update, so an in-place audience→seat upgrade (which never calls
  `/join` again) still gets tracked correctly.
- `voice_sfu/index.js` — `/join`/`/leave` routes updated for the new
  bookkeeping calls and the `NOT_IN_ROOM` status mapping (`NOT_SEATED`
  kept in the mapping defensively, though `provider.js` can no longer
  throw it).
- `public/voice-sfu.js` — added `publishMicTrack()`/`unpublishMicTrack()`,
  operating on the **currently connected** `Room` object — the actual
  "no reconnect" mechanism. `connect()`/`disconnect()` now also track
  the `LocalTrackPublication` reference these use.
- `public/app.js` — new `connectSfuAsAudience()` (hooked into the
  existing `room-state` handler, covers join + reconnect + refresh in
  one place), new `downgradeSfuToAudience()` (hooked into the existing
  `seat-update`/`leave` handler's self-case), `connectSfuRoom()`
  rewritten to upgrade-in-place when already connected instead of
  reconnecting, and a guard on the mic-toggle button so audience can't
  even attempt to publish.

**Known race, disclosed rather than hidden:** the server's permission
grant (`sync.js`'s `onSeatChanged`) is fire-and-forget, so a client
upgrading from audience to seated can attempt to publish before the
LiveKit-side permission update has landed. Mitigated with one
client-side retry (~700ms) — not eliminated. Never observed in a real
browser session because none was available to test in (see §7).

### Item 2 — Real LiveKit validation

Built `scripts/sfu-production-validate.js`: connection validator (raw
HTTP(S) reachability to `LIVEKIT_URL`), token validator (mints a real
token via `token.js`, checks JWT structure/grant/expiry), and a smoke
test (real room create → list → list-participants → update-participant
→ delete, via `livekit.js`, against **whatever `LIVEKIT_URL` is set
to** — no mocking inside this script itself).

**Honest status: implemented, not executed against real infrastructure.**
This sandbox has no network egress and no real LiveKit deployment. I
verified the script's *logic* by installing a local structural stub of
`livekit-server-sdk` (JWT-shaped `AccessToken`, no-op
`RoomServiceClient`) purely for this verification, then deleted it —
it is **not** part of the delivered code. Against that stub: token
validation passed, all 4 smoke-test steps passed, and the connection
validator correctly *failed* against a fake, non-resolving hostname —
proving the failure-detection path itself works, not just the
happy path.

### Item 3 — Production load-test tooling

Built `scripts/sfu-load-test.js` with 5 scenarios (`joins`,
`reconnects`, `room-cycles`, `seat-changes`, `tokens`), a bounded
worker-pool runner, and min/avg/p95/max latency reporting. Drives the
real `token.js`/`livekit.js` — same "no mocking in the delivered file"
approach as item 2.

**Honest status: same as item 2** — implemented, logic-verified against
the local stub (ran `room-cycles` and `tokens` scenarios end-to-end,
correct latency stats and zero errors), **never run against a real
LiveKit deployment**. This is explicitly a worker-pool burst generator
(bounded concurrency), not a fixed-rate throughput benchmark — noted in
the script's own header so it isn't oversold later.

### Item 4 — Monitoring improvements

Extended `voice_sfu/health.js` (did not replace anything — every Step
3.4/3.5 field, including the original `liveKitApiLatencyMs`, is
untouched and still populated exactly as before):
- New per-operation latency breakdown: `latencyMs.{token, join,
  permissionUpdate, cleanup, reconnect, livekitApi}`, fed from
  `sync.js`'s existing `safe()` wrapper (categorized by its existing
  `label` string — no call site changed its signature) plus two new
  timing points in `index.js`'s `/join` route.
- New `activePublishers`/`activeSubscribers`, summed from
  `roomManager`'s new bookkeeping (item 1).

**Verified:** manual script run confirmed `onSeatChanged` correctly
moves a user in/out of the publisher count across a full
audience→seat→audience cycle (§ below). Full regression suite
(`scripts/sfu-step35-verify.js`) still 23/23 after these changes.

### Item 5 — Admin dashboard

Already present (see §0). Verified, not authored, by me this step.
Displays readiness, rollout mode/percentage, SFU health counters,
per-category latency, active local rooms (with publisher/subscriber
split), and recent events — reusing the existing `/health` and
`/readiness` routes, no new admin API added.

### Item 6 — Documentation

`LIVEKIT_PRODUCTION.md` — installation, staged-rollout deployment,
rollback, an audience-feature capacity note specific to this step, a
pre-flight checklist, load-test procedure, every health/readiness field
explained, a known-limitations section (copied honestly from this
report, not softened), and a troubleshooting table.

### Item 7 — End-to-end verification

See §7 below — kept explicitly separated into Verified / Not Verified
/ Assumed, as instructed.

---

## 2. Exact files changed

**Added:**
- `voice_sfu/roomManager.js` — additive functions only (see §1)
- `scripts/sfu-production-validate.js`
- `scripts/sfu-load-test.js`
- `LIVEKIT_PRODUCTION.md`
- `PHASE3_STEP36_REPORT.md` (this file)

**Modified (additive only — no existing function signature removed or
changed for an existing caller):**
- `voice_sfu/roomManager.js`
- `voice_sfu/provider.js`
- `voice_sfu/sync.js`
- `voice_sfu/index.js`
- `voice_sfu/health.js`
- `public/voice-sfu.js`
- `public/app.js`

**Already present, not modified by me, verified only (see §0):**
- `admin/app.js`
- `admin/index.html`
- `rbac.js`

**Not modified — confirmed byte-identical to Step 3.5:**
- `server.js` (`diff` against a fresh extraction of the uploaded ZIP:
  zero difference)
- `voice_sfu/token.js`, `voice_sfu/livekit.js`, `voice_sfu/rollout.js`,
  `voice_sfu/startupCheck.js`, `voice_sfu/roomManager.js`'s
  pre-existing functions (`toLiveKitRoomName`, `isUserSeatedInRoom`,
  `recordJoin`, `recordLeave`, `getLocalParticipantCount`,
  `getPingPongRoom`), `room-recovery.js`, every `redis/*` file,
  `callSignaling.js`, `callHosting.js`, `turn-config.js`, and every
  other file in the repo.

---

## 3. Verification performed (mechanics)

- **Syntax:** `node --check` on every added/modified `.js` file,
  including `server.js` (to reconfirm it parses even though untouched)
  — all pass.
- **Regression:** `scripts/sfu-step35-verify.js` — **23/23 still
  pass**, unchanged from Step 3.5's own count, confirming no behavior
  change to rollout/rollback/mesh-zero-LiveKit-calls semantics.
- **Unrelated-system regression:** `test/callSignaling.test.js` —
  **13/13 pass**, confirming this step's changes have zero collateral
  effect on the separate private-calling system.
- **`server.js` diff:** zero lines changed (`diff` against the pristine
  uploaded ZIP).
- **Route/function collision scan:** all 6 `voice_sfu/index.js` routes
  present exactly once, no new route added this step. Every new
  function (`isUserInRoom`, `setPublisherStatus`,
  `getLocalPublisherCount`, `recordTokenLatency`, `recordJoinLatency`,
  `connectSfuAsAudience`, `downgradeSfuToAudience`,
  `publishMicTrack`, `unpublishMicTrack`) defined exactly once, grepped
  to confirm.
- **Functional test — `provider.js` token issuance** (real
  `token.js`/`livekit.js` code, local structural SDK stub only): seated
  user → `canPublish:true` token with a `canPublish:true` LiveKit
  grant; audience member → `canPublish:false` token with a matching
  grant; non-member → rejected with `NOT_IN_ROOM`. All three confirmed
  by decoding the actual JWT payload, not just reading the return
  value.
- **Functional test — `sync.js` publisher bookkeeping**: simulated
  audience-join → seat-take → move-to-audience in sequence;
  `roomManager.getLocalPublisherCount()` read `0 → 1 → 0` correctly at
  each step.
- **Functional test — `roomManager.js` in isolation**: `isUserInRoom`/
  `isUserSeatedInRoom` correctness on a hand-built `rooms` fixture;
  `setPublisherStatus`/`getLocalPublisherCount`/`listActiveLocalRooms`/
  `clearLocalCount` full lifecycle.
- **Functional test — new scripts**: both new scripts confirmed to
  fail closed with a clear, correct message and non-zero exit code
  when LiveKit isn't configured (the real state of this sandbox); both
  confirmed to execute their real logic correctly against the local
  SDK stub (`room-cycles` and `tokens` load-test scenarios ran with 0
  errors; `sfu-production-validate.js` correctly passed 8 checks and
  correctly *failed* the one check that should fail — DNS resolution
  of a fake hostname).

---

## 4. Verified / Not Verified / Assumed (spec item 7, kept separated)

**Verified** (actually run, in this sandbox, this step):
- All syntax checks above.
- All regression suites above (23/23, 13/13).
- `server.js` zero-diff.
- `provider.js` audience/seated/outsider token logic, via real
  `token.js`/`livekit.js` code against a local structural SDK stub.
- `sync.js` publisher-bookkeeping correctness across a full transition
  cycle.
- `roomManager.js` new functions in isolation.
- Both new scripts' control flow (configured-stub path and
  unconfigured-fail-closed path).
- Admin dashboard code: static correctness (syntax, DOM ID/CSS class
  matching, no unsafe patterns) — **not** a live render in a browser.

**Not Verified** (explicitly, because no real LiveKit deployment or
browser was available in this sandbox):
- A real browser connecting to a real LiveKit room as audience and
  actually hearing a seated speaker.
- The audience→seat in-place upgrade actually working in a real
  browser (no reconnect, mic audio flowing) rather than just the
  server-side token/permission logic being correct.
- The seat→audience downgrade actually stopping outbound audio in a
  real LiveKit session.
- `scripts/sfu-production-validate.js` and `scripts/sfu-load-test.js`
  against a real LiveKit server.
- The known publish-permission race (§1, item 1) actually occurring,
  or the 700ms retry actually being sufficient, in real network
  conditions.
- The admin dashboard rendering correctly in an actual browser (only
  static-analyzed, per above).
- Any multi-instance/cluster behavior of the new bookkeeping (each
  instance's counts were already documented as per-instance-only since
  Step 3.2 — this step doesn't change that scope, but also doesn't
  re-verify it).

**Assumed** (reasoned from code, not tested):
- LiveKit's JS client SDK v2's `localParticipant.publishTrack()`/
  `unpublishTrack()` behave as documented against an *already
  connected* `Room` (this was true for the *initial* connect+publish
  path since Step 3.3, which was itself flagged as never
  browser-tested; this step's in-place upgrade path makes the same
  assumption one layer further).
- LiveKit server-side enforces `canPublish:false` from a token's baked
  grant AND honors a live `updateParticipant` permission change on an
  already-connected participant (both are documented LiveKit
  behaviors, standard SFU permission model — not verified against a
  running LiveKit server here).

---

## 5. Honest limitations list (non-exhaustive, but everything I'm aware of)

- Everything in §4's "Not Verified" section.
- The admin-dashboard provenance anomaly (§0) — content is verified
  safe and correct by inspection, but its origin is unaccounted for.
- The audience-upgrade publish-permission race (§1, item 1) — mitigated,
  not eliminated.
- Load-test tooling is a burst/worker-pool generator, not a
  fixed-rate/sustained-throughput benchmark (documented in the script
  and in `LIVEKIT_PRODUCTION.md` §6, not just here).
- `SFU_STAGE_ALLOWLIST_HOSTS` still reuses room `hostId`, not RBAC
  staff accounts — unchanged limitation from Step 3.5, not addressed
  by this step (out of this step's stated scope).
- Multi-instance/cluster-wide metric accuracy — unchanged, per-instance
  only, as it has been since Step 3.2.

---

## 6. Production readiness status

**Not production-ready for real user traffic yet** — specifically
because of the "Not Verified" list in §4, all of which requires a real
LiveKit deployment and real browsers that weren't available while
building this step. The code is complete, internally consistent, and
passes every check this sandbox could run.

**What's needed before Stage 2 (internal testing) of the rollout in
`LIVEKIT_PRODUCTION.md`:**
1. `npm install livekit-server-sdk`, set the three required env vars.
2. Run `node scripts/sfu-production-validate.js` for real — must pass
   all three checks.
3. One real manual test: a seated speaker and a non-seated audience
   member, in the same room, on a real LiveKit deployment, in real
   browsers — confirm audience actually hears the speaker, confirm
   taking a seat upgrades in place (check the browser console for the
   "in-place upgrade, no reconnect" log line vs. a fresh "connected"
   log line), confirm moving back to audience stops outbound audio but
   keeps incoming audio.
4. Only then proceed to `SFU_STAGE_ALLOWLIST_ROOMS` with one or two
   real rooms, per `LIVEKIT_PRODUCTION.md`'s checklist.

`VOICE_MODE=mesh` remains the default and is completely unaffected —
nothing in this step changes mesh behavior, verified by the zero
`server.js` diff and the passing regression suites.
