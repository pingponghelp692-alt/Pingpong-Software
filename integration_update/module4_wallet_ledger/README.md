# Module 4 — Wallet Ledger & Redis Coordination Layer

Standalone, like `integration_update/country_permission` and
`integration_update/merchant`. Nothing in this folder is required by, or
modifies, `server.js` or the existing `redis/` or wallet-adjacent files
(`coinCenter.js`, `diamondSeller.js`, `rechargeWithdrawApproval.js`,
`callHosting.js`, etc.) at the project root. It only activates if a future
stage explicitly calls `attach()` from `index.js`.

## What's here

| File | Purpose | Backing store |
|---|---|---|
| `wallet/index.js` | credit / debit / transfer, ledger, idempotency, reconciliation | Postgres (truth) + Redis (lock/cache only) |
| `wallet/db.js` | Postgres pool + schema bootstrap | Postgres |
| `redis/connectionFactory.js` | single/cluster/sentinel-agnostic ioredis client builder | Redis (connection only) |
| `redis/keyspace.js` | cluster-safe key naming (hash tags) | none |
| `redis/lock.js` | distributed lock (SET NX PX + Lua CAS release/extend) | Redis |
| `redis/roomState.js`, `redis/routing.js`, `redis/userProfile.js` | cross-instance room/session state, separate from the root `redis/` layer | Redis |
| `migrations/001_module4_wallet_extension.sql` | `module4_wallet_ledger`, `module4_wallet_balances` tables — additive only | Postgres |
| `test/` | regression + boundary test suite, runs against a mock Postgres (see `test/mockPg.js`) since no live Postgres is reachable in this environment | — |
| `docs/` | the Module 4 audit trail from the verification session that produced this package | — |

## Why the wallet ledger is not the live authority yet

`server.js` currently mutates wallet balances in-memory
(`found.user.coins` / `found.user.diamonds`), persisted via `saveUsers()`,
with `logTransaction()` as the audit trail — at 10+ call sites (gifts,
recharge/withdraw approval, daily/weekly rewards, treasure chest, instant
exchange, call-hosting billing, and others). This module is a complete,
separately-audited, Postgres-backed ledger with idempotent, replay-safe,
crash-safe transaction handling — but it has never been called from a real
request handler, and cutting it over means:

1. A live Postgres instance to migrate existing balances into (not
   available in this environment — see the root report's Test Results).
2. Rewriting every one of those 10+ call sites in the same change.
3. Deciding what happens to in-flight balances during the cutover window.

Doing that without a live database to verify against would be an
unverified, effectively irreversible data-authority change — exactly what
the integration brief said not to do. So, as with `country_permission`'s
Postgres mirror, this ships **complete and ready, not yet wired as the
primary store**.

## A gap found and fixed during this integration pass

`wallet/index.js`'s `applyClampIfNeeded()` had `currency` in scope but
never forwarded it to the injected `clampFn`, so one injected function
could not tell a coins clamp from a diamonds clamp — a real problem once
the injected function is meant to be server.js's two separate
`clampCoinBalance`/`clampDiamondBalance` functions rather than a single
placeholder. Fixed by adding `currency` as a 4th argument to that one call
site (purely additive — any existing 3-arg `clampFn` still works
unmodified). See the diff note left in `wallet/index.js` at that line.
This is the only line in this package that differs from the uploaded
`pingpong-module4-final` source; everything else is unmodified.

## Redis key namespace

This module's Redis keys all use the `pingpong:{tag}:suffix` cluster-safe
hash-tag format (see `keyspace.js`), which is a different literal key
shape from the root `redis/roomState.js`'s `pingpong:room:state:<id>`
keys. They do not collide as strings, but they are two independent
authorities for overlapping room-state concepts if both were ever active
at once. Only the root `redis/` layer is currently wired into `server.js`
and the live sync loop; this module's `redis/roomState.js` /
`redis/routing.js` / `redis/userProfile.js` are dormant until something
calls them. Do not enable both as writers of the same room's state
without reconciling the two key schemes first.

## Environment variables

None of these are set anywhere by default — every one has a safe fallback
(no Postgres/Redis configured = the degrade paths described above), so
adding this module changes nothing about a deployment unless these are
explicitly set.

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `MODULE4_WALLET_DATABASE_URL` | `wallet/db.js` | falls back to `DATABASE_URL`, then unset | If neither is set, wallet writes fail loudly (by design — see `db.js` header) rather than silently no-op. |
| `DATABASE_URL` | `wallet/db.js` | unset | Shared fallback with the rest of the project's Postgres usage (e.g. `perf/dbPersistence.js`). |
| `MODULE4_WALLET_DB_POOL_MAX` | `wallet/db.js` | `5` | Postgres pool size, this module's pool only (separate from `perf/dbPersistence.js`'s pool — see that file's header for why). |
| `PGSSL` | `wallet/db.js` | SSL on (`rejectUnauthorized: false`) | Set to `"false"` to disable SSL for local/dev Postgres. |
| `MODULE4_WALLET_LOCK_TTL_MS` | `wallet/index.js` | `5000` | Redis per-user lock TTL (contention-reduction only, not correctness-critical). |
| `MODULE4_WALLET_CACHE_TTL_MS` | `wallet/index.js` | `3000` | Redis balance read-cache TTL. |
| `REDIS_TOPOLOGY` | `redis/connectionFactory.js` | `single` | `single` \| `cluster` \| `sentinel`. |
| `REDIS_URL` / `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` / `REDIS_TLS` | `redis/connectionFactory.js` | unset | Single-instance topology config. |
| `REDIS_CLUSTER_NODES` | `redis/connectionFactory.js` | unset | Comma-separated `host:port` seed list, cluster topology. |
| `REDIS_SENTINEL_NODES` / `REDIS_SENTINEL_MASTER_NAME` | `redis/connectionFactory.js` | unset / `mymaster` | Sentinel topology. |
| `REDIS_KEY_PREFIX` | `redis/keyspace.js` | `pingpong:` | Shares the same default prefix as the root `redis/client.js`, but the two are still two independent key *shapes* — see "Redis key namespace" above. |
| `MODULE4_ROOM_LOCK_TTL_MS`, `MODULE4_ROUTE_TTL_MS`, `MODULE4_ROUTE_REFRESH_MS`, `MODULE4_PROFILE_TTL_SECONDS` | `redis/roomState.js`, `redis/routing.js`, `redis/userProfile.js` | see each file | Only relevant once those dormant files are actually called — not exercised by the wallet path. |

## Cutover runbook (for whenever a future stage decides to activate this)

This module intentionally ships inactive (see above). When the decision is
made to cut over, in order:

1. **Provision real Postgres** and set `DATABASE_URL` (or
   `MODULE4_WALLET_DATABASE_URL`). Run
   `node integration_update/database/index.js --dry-run` first to confirm
   only the expected 3 migrations are picked up, then without `--dry-run`
   to apply them. `wallet/db.js`'s `ensureSchema()` also runs the same
   `CREATE TABLE IF NOT EXISTS` statements idempotently on `attach()`, so
   this step is a safety net, not the only path.
2. **Re-run this module's own test suite against the real Postgres**, not
   just `test/mockPg.js` — the mock only proves the SQL shapes are
   correct, not real MVCC/row-lock behavior under concurrency.
3. **Write and test a one-time balance migration** from the live
   `user.coins` / `user.diamonds` objects into `module4_wallet_balances`
   (one opening-balance row per user/currency, with its own auditable
   ledger entry — do not just `UPDATE` the balances table directly, or
   `reconcileBalance()` will show drift from day one).
4. **Decide and test the in-flight-transaction story** for the cutover
   window itself (e.g. a brief maintenance window vs. dual-write
   shadow period) — not designed or tested by this package.
5. **Rewrite each of the 10+ existing wallet call sites** (see "Why the
   wallet ledger is not the live authority yet" above) to call
   `wallet.credit()`/`debit()`/`transferBetweenUsers()` instead of
   mutating `user.coins`/`user.diamonds` directly, one call site at a
   time, each with its own test.
6. **Rollback plan**: until step 5 is complete for *all* call sites, do
   not remove the old in-memory path — a partially-migrated wallet with
   two authorities is worse than the current single-authority state.
   `module4_wallet_ledger` never deletes or mutates the existing
   `user.coins`/`user.diamonds`/`logTransaction()` data, so reverting
   before step 5 finishes is just "stop calling `attach()`."

## Usage, when a future stage decides to cut over

```js
const module4Wallet = require("./integration_update/module4_wallet_ledger")
    .attach({ pgPool, clampCoinBalance, clampDiamondBalance, redisPool });
```

See `index.js` for the full adapter and `docs/MODULE4_FINAL_AUDIT_REPORT.md`
for the audited API and accounting guarantees.
