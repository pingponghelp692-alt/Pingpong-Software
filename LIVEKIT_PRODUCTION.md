# LIVEKIT_PRODUCTION.md
## PingPong — LiveKit SFU Voice Provider: Production Guide

Covers everything needed to take the LiveKit SFU voice path (`voice_sfu/`,
`public/voice-sfu.js`) from "implemented" to "serving real traffic
safely." Written as of Phase 3, Step 3.6. Mesh (`VOICE_MODE=mesh`,
unset) remains the default and is unaffected by anything in this
document.

---

## 1. Installation

1. `npm install livekit-server-sdk` (listed in `package.json` as a
   dependency — not auto-installed by a bare `npm install` if your
   lockfile predates Step 3.2; run it explicitly).
2. Provision a LiveKit deployment — either self-hosted (see LiveKit's
   own docs for `livekit-server`) or LiveKit Cloud. This app never
   bundles or runs a LiveKit server itself; `voice_sfu/` is a client of
   one, nothing more.
3. Set three required environment variables:

   | Var | Example | Notes |
   |---|---|---|
   | `LIVEKIT_URL` | `wss://your-project.livekit.cloud` | `ws://`/`wss://` form (client-facing); `livekit.js` internally converts to `https://`/`http://` for its own server-admin calls — you never need two separate URLs. |
   | `LIVEKIT_API_KEY` | from your LiveKit project | |
   | `LIVEKIT_API_SECRET` | from your LiveKit project | Treat like any other secret — server-side env var only, never sent to a client. |

4. Optional: `LIVEKIT_TOKEN_TTL_SECONDS` (default 21600 = 6h).

None of this affects a deployment that leaves `VOICE_MODE` unset —
mesh is the default and every file in `voice_sfu/` is fail-safe/inert
until `VOICE_MODE` is `staged` or `sfu` (see `voice_sfu/token.js`'s
lazy-require pattern).

---

## 2. Deployment (staged rollout)

Do not flip `VOICE_MODE=sfu` for all traffic in one step. Use the
staged rollout built in Step 3.5 (`voice_sfu/rollout.js`):

| Stage | Config | Who gets SFU |
|---|---|---|
| 1 — Mesh (default) | `VOICE_MODE=mesh` or unset | nobody |
| 2 — Internal testing | `VOICE_MODE=staged`, `SFU_STAGE_ALLOWLIST_ROOMS=roomId1,roomId2` | only those rooms |
| 3 — Staff-hosted rooms | `VOICE_MODE=staged`, `SFU_STAGE_ALLOWLIST_HOSTS=userId1,userId2` | rooms hosted by those userIds |
| 4 — Percentage | `VOICE_MODE=staged`, `SFU_STAGE_PERCENT=5` (then 25, 50, ...) | that % of rooms, by a stable hash of `roomId` — a room's answer never flaps mid-config |
| 5 — Full | `VOICE_MODE=sfu` | everyone |

The decision is always made **per room**, never per user, so every
participant in a given room is guaranteed to be on the same transport
(see `PHASE3_STEP35_REPORT.md` §3 for why this matters — mixed
transports in one room means some people literally can't hear others).

Moving between any two stages is a **config-only change** — no
redeploy of client assets, no database migration, no code change.

---

## 3. Rollback

Set `VOICE_MODE=mesh`. That's the entire rollback procedure, from any
stage. Every room reverts to mesh on its next `/join` call, instantly,
no other action required (verified in `scripts/sfu-step35-verify.js`
§3). Nothing about mesh's own code path is ever touched by SFU/staged
rollout being on or off.

---

## 4. Staged rollout — audience feature note (Step 3.6)

As of this step, **audience (non-seated) members also connect to
LiveKit** when a room is on the SFU side — as subscribe-only listeners,
never publishers. This means SFU-side LiveKit load includes audience
connections, not just seated speakers. Size your LiveKit deployment
(and read the `activeSubscribers` metric on the admin dashboard) with
that in mind before widening a percentage rollout — a large-audience
room now means a large LiveKit participant count for that room, even
if only a handful of seats are filled.

---

## 5. Pre-flight checklist (before moving past Stage 1)

1. `npm install livekit-server-sdk`.
2. Set the three required env vars (§1).
3. Run `node scripts/sfu-production-validate.js` against your real
   deployment. All three checks (connection, token, smoke test) must
   pass. **This has not been run against a real LiveKit deployment as
   part of Step 3.6** — the sandbox this step was built in has no
   network egress. Run it yourself before trusting it.
4. Check `GET /api/admin/voice-sfu/readiness` (admin panel → Voice SFU,
   or the raw route) reports `ready: true`.
5. Stage 2: set a real internal test room in
   `SFU_STAGE_ALLOWLIST_ROOMS`. Manually verify, with real people/real
   browsers: seated speakers can hear each other, a non-seated visitor
   who opens the room also hears them (the audience feature), and
   taking/leaving a seat updates who can publish — all against your
   real LiveKit instance. **This step could not perform this
   verification itself** (no browsers, no network, no real LiveKit
   server available in the build sandbox).
6. Watch the admin panel's Voice SFU section (or
   `GET /api/admin/voice-sfu/health`) during the test: `errorCount`,
   `tokenFailureCount`, latency numbers.
7. Optionally run `node scripts/sfu-load-test.js <scenario>` against a
   staging LiveKit project before widening the rollout percentage —
   see §6.
8. Stage 3/4: widen via `SFU_STAGE_ALLOWLIST_HOSTS` and/or
   `SFU_STAGE_PERCENT`, watching health at each step.
9. Stage 5: `VOICE_MODE=sfu`.
10. Keep `VOICE_MODE=mesh` documented as the one-line rollback at every
    stage (§3).

---

## 6. Load-test procedure

`scripts/sfu-load-test.js` drives `voice_sfu/token.js` and
`voice_sfu/livekit.js` directly (no PingPong server, no browsers
needed) against your real LiveKit deployment:

```
LIVEKIT_URL=wss://your-project.livekit.cloud \
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
node scripts/sfu-load-test.js <scenario> [--n=50] [--rooms=5] [--concurrency=10]
```

Scenarios: `joins` (many simultaneous joins), `reconnects` (reconnect
storm — same identities re-minting rapidly), `room-cycles`
(open/close churn), `seat-changes` (permission-update churn — the same
call `sync.js`'s `onSeatChanged` makes on every seat/audience
transition), `tokens` (pure token-minting cost, isolated from LiveKit
network calls).

This is a burst/worker-pool load generator (bounded concurrency, not a
fixed-rate scheduler) — good for "can it survive N simultaneous
joins," not a substitute for a proper sustained-throughput benchmark
if you need one. **Not run against a real deployment as part of Step
3.6** — same sandbox network limitation as §5 item 3.

---

## 7. Health/readiness endpoint meanings

**`GET /api/admin/voice-sfu/readiness`** (admin-auth,
`voice-sfu:manage` permission) — config-level check, safe to poll
before every stage change:
- `ready: true/false`
- `errors[]` — missing SDK / missing required env vars (only reported
  when `VOICE_MODE` is `staged` or `sfu`)
- `warnings[]` — e.g. `staged` mode with no rollout knobs set (fails
  closed to mesh, but likely not intended)

**`GET /api/admin/voice-sfu/health`** (same auth) — live telemetry,
merges mesh (`voice-health.js`, untouched) and SFU sections:
- `sfu.joinCount` / `leaveCount` / `errorCount` / `tokenFailureCount` /
  `cleanupCount` / `reconnectEventCount` — running counters since
  process start.
- `sfu.activePublishers` / `activeSubscribers` — best-effort, **this
  instance's local count only** (see §8 — not authoritative, not
  cluster-wide).
- `sfu.latencyMs.{token,join,permissionUpdate,cleanup,reconnect,livekitApi}`
  — rolling averages per operation category (Step 3.6). `token` = time
  to mint a JWT; `join` = full `/join` REST round trip; the rest mirror
  `sync.js`'s hooks.
- `sfu.liveKitApiLatencyMs` — the original Step 3.4 generic bucket,
  kept unchanged alongside the new breakdown above.
- `sfu.activeLocalRooms[]` — `{ roomName, localParticipantCount,
  localPublisherCount }` per room this instance has minted tokens for.
- `sfu.recentEvents[]` — bounded ring buffer of the last 200 join/
  leave/error/cleanup events.
- `voiceMode` — `mesh` / `sfu` / `staged`; `rolloutConfig` present only
  when `staged`.

---

## 8. Known limitations (read before relying on any metric above)

- **Per-instance, not cluster-wide.** In a multi-instance deployment,
  every count above (`activePublishers`, `activeLocalRooms`, etc.) is
  only what THIS instance minted tokens for — LiveKit itself
  (`listParticipants`/`listRooms`) is the actual cluster-wide source of
  truth if you need a global number. This was already true since Step
  3.2 and is unchanged by Step 3.6.
- **Best-effort bookkeeping, never authorization.** `roomManager.js`'s
  publisher tracking exists purely to feed the metrics above. LiveKit's
  own per-participant permission (set via `updateParticipant`) is what
  actually enforces who can publish — this bookkeeping cannot desync
  into a security problem even if it drifts from reality for a metric.
- **Percent-rollout hashing (FNV-1a) is not cryptographic** — fine for
  traffic splitting, not a security boundary (Step 3.5).
- **Validation/load-test tooling is unverified against real
  infrastructure** — see §5/§6. Implemented, logic-tested with a local
  structural stub of the LiveKit SDK, never run against a real
  deployment, because this step was built in a sandbox with no network
  egress.
- **The audience-listening feature (Step 3.6) has a small, known
  client-side race**: when a user is upgraded from audience to
  publisher, the server's permission grant (`sync.js`'s
  `onSeatChanged`) is fire-and-forget and may not have reached LiveKit
  yet when the client attempts to publish. The client retries once
  after ~700ms; if that also fails, the mic-toggle button lets the
  person retry manually. This has not been observed in a real browser/
  real-LiveKit test — only reasoned through from the code (no live
  environment available to reproduce or measure it here).
- **`SFU_STAGE_ALLOWLIST_HOSTS` reuses room `hostId`, not RBAC staff
  accounts** — same limitation noted since Step 3.5, unchanged.

---

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `/join` returns 503 | LiveKit env vars missing/wrong | `GET /api/admin/voice-sfu/readiness` |
| `/join` returns 403 | Caller isn't a member of the PingPong room at all (not even audience) — see `NOT_IN_ROOM` | Confirm the client actually joined the room (socket `join-room`) before calling `/api/voice-sfu/join` |
| Seated user can't be heard | LiveKit permission update racing the client's publish attempt (§8) | Check `sfu.latencyMs.permissionUpdate`; have the user retry the mic button |
| Audience hears nothing | `connectSfuAsAudience()` never fired, or `voiceMode` still reports `mesh` on the client | Check `GET /api/voice-sfu/mode`; confirm `VOICE_MODE`/staged rollout actually includes that room |
| `tokenFailureCount` rising | LiveKit down, or SDK/env misconfigured mid-session | `GET /api/admin/voice-sfu/health` → `sfu.recentEvents` for the actual error messages |
| Orphaned LiveKit rooms | Should self-heal — `livekit.js`'s `ensureRoom` sets a 5-minute `emptyTimeout`, and `sync.js`'s `onRoomClosed`/`onRoomPossiblyEmpty` delete proactively | `sfu.cleanupCount`; manually `deleteRoom` via `scripts/sfu-production-validate.js`-style calls if needed |

---

## Production checklist (copy of §5, for quick reference)

- [ ] `npm install livekit-server-sdk`
- [ ] `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` set
- [ ] `node scripts/sfu-production-validate.js` passes
- [ ] `GET /api/admin/voice-sfu/readiness` → `ready: true`
- [ ] Stage 2 manual test: seated↔seated, audience listening, seat↔audience transitions, all against real LiveKit
- [ ] `node scripts/sfu-load-test.js` run against staging
- [ ] Stage 3/4 widened gradually, health watched at each step
- [ ] Stage 5 (`VOICE_MODE=sfu`) only after the above
- [ ] Team knows `VOICE_MODE=mesh` is the instant rollback
