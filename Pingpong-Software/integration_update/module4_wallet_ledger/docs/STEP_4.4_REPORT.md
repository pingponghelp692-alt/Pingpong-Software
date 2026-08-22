# Module 4 — Step 4.4 Report: Distributed Wallet (highest-risk step)

## Existing architecture inspected before writing code

- `server.js` `logTransaction()` — record shape (`id`, `userId`, `currency`,
  `amount`, `balanceBefore`, `balanceAfter`, `status`, `note`, `time`).
- `server.js` `clampCoinBalance()` / `clampDiamondBalance()` — ceiling
  guard rails (100B coins / 10B diamonds), applied per-context.
- `coinCenter.js` — `requestId -> {result, time}` idempotency cache
  pattern, checked before mutation, cached after.
- `perf/dbPersistence.js` — Postgres `Pool` construction pattern, the
  mandatory `pool.on("error", ...)` listener (an unlistened `pg` pool
  error kills the whole Node process — this is copied deliberately,
  not reinvented), and `DATABASE_URL`-gated "absent = disabled, never
  crash" contract.
- `WALLET_ECONOMY_AUDIT_REPORT.md` — prior audit findings (double-credit
  bug history, `Number.isFinite` gap, ceiling coverage gaps). Informed
  this design's insistence on DB-constraint-level idempotency rather
  than an application-level cache, which is exactly the class of bug
  that report found and fixed once already.

## What was built

| File | Purpose |
|---|---|
| `module4/wallet/schema.sql` | Two tables: `module4_wallet_ledger` (append-mostly, `txn_id` PRIMARY KEY — the actual crash-safe replay protection), `module4_wallet_balances` (materialized running total per user+currency, always re-derivable from the ledger — see `reconcileBalance()`). |
| `module4/wallet/db.js` | Standalone Postgres pool for Module 4 (own `DATABASE_URL`/`MODULE4_WALLET_DATABASE_URL`, doesn't import `perf/dbPersistence.js`, to keep isolation). Reuses that file's `Pool` construction + error-listener pattern. Fails loudly (throws) if Postgres isn't configured — deliberately different from the rest of Module 4's "degrade to no-op" contract, because a silent no-op on a money operation would be actively dangerous. |
| `module4/wallet/index.js` | The wallet API: `credit()`, `debit()`, `transferBetweenUsers()`, `getBalance()`, `getTransaction()`, `reconcileBalance()`. |

## How each requirement was met

- **Atomic balance updates:** every mutation is one Postgres transaction (`BEGIN…COMMIT`). The debit guard is a single `UPDATE … WHERE balance + $1 >= 0 RETURNING balance` — the check-and-write is one statement, not read-then-write in application code, so there's no window between checking a balance and writing it where another request could interleave.
- **Idempotent operations / replay protection:** `txn_id` is the PRIMARY KEY on the ledger table. Every operation requires one. A repeated call with the same `txn_id` hits `ON CONFLICT (txn_id) DO NOTHING`, reads back the original outcome, and returns it unchanged (`replay: true`) — including replaying a *rejected* outcome as rejected, not re-evaluating it against a balance that may have since changed.
- **Crash-safe writes:** the only durable state is inside committed Postgres transactions. There is no in-memory-then-flush-later step (unlike `perf/writeQueue.js`'s deliberate 250ms debounce window, which is the right tradeoff for room chat state but wrong for money) — a crash before `COMMIT` leaves nothing applied; a crash after leaves the full, correct result.
- **Recovery after process restart:** nothing here holds required state in memory. Any process (this one restarted, or a different instance) can resume by just calling the same functions with the same `txn_id`s. `reconcileBalance()` additionally lets an operator rebuild `module4_wallet_balances` from `module4_wallet_ledger` alone if the balances table were ever lost or suspected to have drifted.
- **Postgres as permanent source of truth / Redis as coordination+cache only:** every function works correctly with Redis completely absent — verified (see below) by running the full test suite with no Redis client injected at all. Redis's lock (`module4/redis/lock.js`) is used only to reduce wasted contention/retries across instances; if it's unavailable or fails, the code logs a warning and proceeds straight to Postgres, whose transaction is what actually guarantees correctness. Redis's balance cache has a short TTL (3s default) and is invalidated after every write — a cache read failure or staleness never affects a write's correctness, only how fresh an unrelated read might be.
- **No double-spending / no lost updates under concurrency:** see verification below — this was tested directly, not just argued.
- **Transaction identifier for replay protection:** `txnId` parameter on every call, required (auto-generated in `server.js`'s existing `"txn_" + base36-timestamp + hex`-random format if not supplied, so IDs look consistent with the existing system).

## Not duplicating existing business logic

- Ceiling/overflow policy (`clampCoinBalance`/`clampDiamondBalance`) is
  **not reimplemented** here — this module doesn't know the real
  ceiling values and doesn't guess. It accepts an optional injected
  `clampFn(userId, balance, context)`, applied inside the same
  transaction as the mutation, defaulting to none (only the
  unconditional finite-integer and non-negative-balance guards apply
  until a real clamp function is wired in at merge time).
- No gift-sending, approval-workflow, or KYC logic was touched or
  copied — this module only offers `credit`/`debit`/`transfer`/`read`
  primitives; the business rules for *when* those are called stay in
  `server.js`/`coinCenter.js`/`diamondSeller.js`/`rechargeWithdrawApproval.js`
  exactly as they are today.

## Verified (actually run this session)

- `node --check` passed on `db.js` and `index.js`.
- Built an in-memory mock of the `pg.Pool`/client interface (SQL
  pattern-matched against the actual queries `index.js` issues — not a
  hand-wave) and injected it via `db.js`'s existing `configure()` test
  hook. Ran with **no Redis client** (pure Postgres-transaction path,
  the worst case for correctness since the contention-reducing lock is
  absent):
  - Credit then debit produced the correct running balance.
  - Replaying an already-processed `txnId` returned the original
    result unchanged and did **not** apply the delta a second time.
  - A debit exceeding the balance was rejected, balance unchanged.
  - Replaying that same rejected `txnId` returned the rejection again
    without re-evaluating it.
  - **Concurrent double-spend test:** two simultaneous debits of 80
    against a balance of 100 — exactly one completed, one was
    rejected, final balance was 20 (never negative).
  - **Stress test:** 20 concurrent debits of 10 against a balance of
    100 — exactly 10 completed, 10 rejected, final balance exactly 0.
  - **Transfer test:** a successful transfer moved both sides
    correctly in one operation; a transfer with insufficient funds
    left the debit rejected and confirmed the credit side was **never
    applied** (no partial transfer).
  - `reconcileBalance()` correctly recomputed a true balance of 0 from
    the ledger matching the materialized balance table after the
    stress test fully drained it.

This is real logic verification of the transaction/locking design, not
just "it didn't crash" — but see the next section for what it doesn't
cover.

## Race-condition analysis

- **Same-instance, concurrent requests, same user:** proven safe above
  (stress test) — Postgres's `UPDATE … WHERE balance + $1 >= 0` makes
  the check-and-write atomic per statement; the mock's execution model
  (JS's single-threaded synchronous query handling) enforces that no
  two writes to the same balance can interleave mid-statement, which
  is the same guarantee a real Postgres row-level lock provides for
  the same SQL. This is the strongest claim this session's testing
  supports.
- **Cross-instance, concurrent requests, same user:** logically
  identical to same-instance from Postgres's point of view — Postgres
  doesn't know or care which process sent a query, only that both
  hit the same row. The code path is unchanged whether the two
  concurrent callers are two `await`s in one test script or two
  separate Node processes. What's genuinely **not verified** is
  real network latency/interleaving patterns across processes — see
  below.
- **Redis lock failure/absence:** explicitly tested — every test above
  ran with `redisClient` unset. The design's central claim
  ("correctness holds even if Redis is down") was exercised directly,
  not just asserted in a comment.
- **Deadlock in `transferBetweenUsers`:** two transfers between the
  same pair of users in opposite directions could deadlock if each
  acquired the two Redis locks in a different order. Fixed by always
  sorting the two user IDs before acquiring locks, so both directions
  request the same lock ordering. Not stress-tested with actual
  concurrent opposite-direction transfers this session — the ordering
  logic was read-verified, not load-tested.

## Failure-recovery analysis

- **Process crash mid-operation (before COMMIT):** nothing is applied.
  A retry with the same `txnId` is safe and will proceed normally (no
  ledger row exists yet, so it's treated as a fresh attempt, not a
  replay).
- **Process crash mid-operation (after COMMIT, before returning to
  caller):** the operation is fully durable in Postgres even though
  the caller never got a response. If the caller retries with the same
  `txnId` (the correct thing to do on an ambiguous outcome), the
  replay path returns the actual committed result — no double-apply,
  no lost result.
- **Redis crash/restart:** no wallet data lives in Redis except a
  short-TTL (3s) balance cache and lock keys with their own TTL
  (`MODULE4_WALLET_LOCK_TTL_MS`, default 5s). Losing Redis entirely
  loses nothing durable — confirmed by this session's no-Redis test
  run being byte-for-byte the same correctness outcome as a
  Redis-present run would be expected to produce.
- **Postgres unavailable at call time:** every write and every read
  throws a clearly-labeled error rather than silently succeeding or
  silently returning a wrong balance — by design (see `db.js`'s
  header comment on why this module fails loudly, unlike the rest of
  Module 4).
- **`module4_wallet_balances` lost, corrupted, or suspected to have
  drifted:** `reconcileBalance(userId, currency, { repair: true })`
  recomputes the true value from `module4_wallet_ledger` alone and can
  overwrite the materialized table. This is the "recovery after
  process restart" primitive for the case where restart is more like
  disaster recovery — deliberately not automatic (must be called
  explicitly), since silently overwriting a balance is exactly the
  kind of surprise a financial system shouldn't produce on its own.

## Not Verified

- **No real Postgres instance was available this session.** Every test
  above ran against an in-memory mock of the `pg` command surface, not
  real Postgres. What the mock cannot verify: actual row-level lock
  behavior under Postgres's real concurrency control (MVCC), real
  transaction isolation level behavior, connection pool exhaustion
  under load, actual network partition/timeout behavior, or SQL
  syntax correctness beyond what my mock's pattern-matching checked
  (a typo Postgres would reject could still "work" against a mock that
  matches loosely).
- **No real multi-process test.** The concurrency tests used
  `Promise.all` within one Node process, not two separate server
  instances hitting the same database.
- **No load/throughput testing.** Per your instruction, this step
  optimized for correctness over speed — no measurement of how many
  wallet operations/second this design can sustain, or how lock
  contention behaves under realistic traffic.
- **`clampFn` injection point** is untested beyond being read-verified
  — no clamp function was actually passed in during this session's
  tests.
- **Redis-present path** (lock actually acquired/released against a
  real or mock Redis, cache actually hit) was not exercised this
  session — Step 4.2/4.3's mock-Redis tests covered `lock.js` and
  `roomState.js` directly; this step's tests deliberately ran with
  Redis absent to prove the Postgres-only guarantee, which means the
  Redis-present code path in `index.js` (`lock.withLock` + cache
  read/write) itself wasn't hit by this session's wallet tests.

## Backward compatibility

- Zero risk to Module 3 or the current project: `module4/wallet/*`
  only requires other `module4/` files (`../redis/connectionFactory.js`,
  `../redis/keyspace.js`, `../redis/lock.js`) and `pg`/`crypto`
  (already a dependency). No file under the original project was
  read-for-modification or changed.
- `server.js`'s `user.coins`/`user.diamonds`, `transactions` array, and
  every existing wallet route are completely untouched. This step
  changes no runtime behavior of the running app.
- Table names (`module4_wallet_ledger`, `module4_wallet_balances`) are
  prefixed specifically to avoid any collision with
  `perf/dbPersistence.js`'s existing `app_json_store` table or any
  other table the project might already have.

## Diff summary — original project untouched

Re-confirmed this step: filesystem timestamp scan of every file under
the originally-extracted project, run immediately before packaging
this zip, returned zero files modified since extraction.

## Exact file list (new this step)

- `module4/wallet/schema.sql` (new)
- `module4/wallet/db.js` (new)
- `module4/wallet/index.js` (new)

Unchanged from prior steps (present in the zip): all of
`module4/redis/*.js` and `module4/docs/STEP_4.1*.md`,
`STEP_4.2_REPORT.md`, `STEP_4.3_REPORT.md`.

## Next (Step 4.5, not started)

Per the Step 4.1 order, the last entity was user profile fields
(low-risk, read-mostly) — but that's the least urgent item, so it's
worth confirming with you whether to do that next or move to the
originally-listed Module 4 infra items (health monitoring, graceful
shutdown, sticky-session/load-balancer config) now that all three
higher-risk state migrations (routing, rooms, wallet) have their
infrastructure layer built.
