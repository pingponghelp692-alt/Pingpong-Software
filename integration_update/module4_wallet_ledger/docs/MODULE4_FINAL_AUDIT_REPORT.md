# Module 4 — Final Integration, Audit & Delivery Report
2026-08-08

## Summary

This session independently re-verified the 5 previously-reported bug fixes
against the actual uploaded source (not the prior session's report text),
ran the existing 23-test regression suite against the real assembled
module tree, added 17 new targeted tests (boundary matrix + the exact
worked accounting example from the task spec + concurrency races), and
did a Phase 2 isolation/SQL-safety sweep. **No new bugs were found.** The
5 fixes already present in the uploaded `connectionFactory.js`,
`userProfile.js`, and `wallet/index.js` are correct and are the only
files that differ from the frozen zip — confirmed by diff, not assumed.

## Phase 0 — Inventory (condensed)

| File | Purpose | DB/Redis touched |
|---|---|---|
| `redis/connectionFactory.js` | builds ioredis client (single/cluster/sentinel) | Redis (connection only) |
| `redis/keyspace.js` | cluster-safe key naming (hash tags) | none (pure fn) |
| `redis/lock.js` | SET NX PX distributed lock, Lua CAS release/extend | Redis |
| `redis/roomState.js` | cross-instance room/seat state | Redis |
| `redis/routing.js` | user→instance routing table | Redis |
| `redis/userProfile.js` | read-through profile cache, allowlisted fields | Redis |
| `wallet/db.js` | Postgres pool, schema bootstrap | Postgres |
| `wallet/index.js` | credit/debit/transfer, ledger, reconciliation | Postgres (truth) + Redis (lock/cache only) |
| `wallet/schema.sql` | `module4_wallet_ledger`, `module4_wallet_balances` | — |

Transaction boundaries: every wallet mutation is one `BEGIN…COMMIT` with
`catch → ROLLBACK → rethrow`. Idempotency: `txn_id TEXT PRIMARY KEY` +
`INSERT … ON CONFLICT DO NOTHING` gate. Locking: Redis lock is a
contention-reduction optimization only; the Postgres row-locked
`UPDATE … WHERE balance + $1 >= 0` is what actually guarantees no
double-spend, with or without the lock.

Compatibility: the 3 uploaded "already-fixed" files (`connectionFactory.js`,
`userProfile.js`, `index.js`) were diffed against the zip's versions —
they are drop-in replacements for `module4/redis/connectionFactory.js`,
`module4/redis/userProfile.js`, and `module4/wallet/index.js` respectively;
no other file references anything that changed shape (same exported
function signatures throughout).

## Phase 1 — Independent re-verification of the 5 bugs

All 5 re-checked directly against source (not the prior report):

1. **Allowlist-before-Redis-down** — `assertKnownFields(patch)` runs as
   the first statement in `setProfile()`, before the `if (!client) return
   false` short-circuit. Confirmed by direct test: `setProfile("u1",
   {coins: 500})` throws even with `client === null`.
2. **Error listeners** — `connectionFactory.createClient()` attaches
   exactly one `client.on("error", …)` per constructed client, after all
   three topology branches converge, so there's no duplicate-listener
   risk. All 4 consumers (`roomState`, `routing`, `userProfile`,
   `wallet/index.js`'s own factory-built client) inherit it for free;
   `wallet/index.js` additionally guards the one path that bypasses the
   factory (an injected `redisPool`) with a `listenerCount === 0` check.
3. **Transfer ceiling clamp** — both `transferBetweenUsers()` legs now
   call the same `applyClampIfNeeded()` helper `applyDelta()` uses.
   Verified with a full boundary matrix (below), not just one case.
4. **Ledger/balance consistency** — verified with the exact numbers from
   the task spec (see below): the invariant holds by construction, not
   tolerance.
5. **Required txnId** — `assertValidTxnId()` throws for missing/empty/
   non-string `txnId` on all 4 entry points; `generateTxnId()` remains an
   opt-in utility, never an automatic fallback.

### Bug #4 — worked example, exactly as specified

```
opening balance   = 990
ceiling           = 1000
credit            = 100
```

Traced through the actual code (not simulated by hand):

1. Opening balance: **990** (seeded via a prior completed ledger row)
2. Mutation ledger row: `txn_id="credit1"`, `amount=+100`, `status=completed`, `balance_after=1000`
3. Clamp ledger row: `txn_id="credit1:clamp"`, `amount=-90`, `reason="ceiling-clamp-adjustment"`, `status=completed`, `balance_after=1000`
4. Final balance (`module4_wallet_balances.balance`): **1000**
5. SUM(completed ledger amounts) for this user/currency: `990 (prior) + 100 + (-90) = 1000`
6. Reconciliation: `reconcileBalance()` → `{ trueBalance: 1000, cachedBalance: 1000, drift: 0 }`

**Accounting equation holds exactly:** `opening + SUM(completed ledger deltas) = final` →
`990 + (100 - 90) = 1000`. ✅ No double-count: the main row keeps the raw
+100 intent (audit trail of what was requested), the clamp row records
only the correction (-90) as its own line item, and the two sum to the
real net change (+10) — never counted twice, never silently dropped.
This was verified by direct assertions against real ledger rows returned
by `getTransaction()`, not by trusting a drift number alone.

## Phase 2 — Full consistency audit

- **SQL**: 100% parameterized (`$1`/`$2`/…), zero template-literal
  interpolation into any query string (grep-verified across `redis/*.js`
  and `wallet/*.js` — the only backtick+`${}` hits are `console.warn` log
  lines, not queries). `BEGIN`/`COMMIT`/`ROLLBACK` boundaries intact.
  Connections always `.release()`d in a `finally` block, success or
  failure. Row-level locking via the atomic `UPDATE … WHERE balance + $1
  >= 0` guards concurrent debits with or without the Redis lock.
- **Wallet**: credit/debit/transfer/ceiling/insufficient-balance/
  invalid-amount/duplicate-txn/rollback/reconciliation all covered by
  the boundary-matrix tests below.
- **Redis**: every client lifecycle path goes through
  `connectionFactory.createClient()` or is explicitly listener-guarded;
  no client construction anywhere in `module4/` bypasses this.
- **Profile/state**: allowlist enforced unconditionally; sensitive
  fields (`banned`, `passwordHash`, `mobile`, etc.) are structurally
  absent from `PROFILE_FIELDS`, not just excluded by convention.
- **Locking**: `lock.js`'s release/extend use a compare-and-delete Lua
  script keyed on a per-acquisition random token, so an expired holder
  can never release a different, newer holder's lock.
- **Isolation**: `grep -rn "require("` across every `redis/*.js` and
  `wallet/*.js` in the final tree resolves only to `ioredis`, `pg`,
  Node builtins (`crypto`, `fs`, `path`, `os`), and other `module4/`
  files. Zero references to `server.js` or any master-tree Redis module.

## Phase 3 — Testing

- `node -c` clean on all 8 Module 4 source files.
- Existing regression suite (`tests/regression_tests.js`, using
  `tests/mockPg.js`): **23/23 passed**, run against the actual assembled
  final tree (not just the loose uploaded files).
- New targeted tests this session (worked example + boundary matrix +
  concurrency): **17/17 passed** — receiver below/at/near/over ceiling,
  debit-side clamp, transfer atomicity on rejection, transfer idempotent
  replay, and two concurrency races (distinct txnIds vs. same txnId
  racing against the mock pool's connection model).
- **Real PostgreSQL integration test not executed.** This sandbox has no
  `psql`/`postgres` binary and no `pg` npm package installed (no network
  egress available to install it). All testing above used `mockPg.js`,
  an in-memory mock of the exact query shapes `wallet/index.js` sends —
  this is not a substitute for a real Postgres run, and one is still
  recommended before Step 4.6 / master merge.

## Phase 4 — Fixes made this session

**None.** No new verified bug or inconsistency was found. All 5
previously-reported fixes were confirmed correct by direct testing
against real code paths (not by trusting the prior report or a
drift-based tolerance).

## Phase 5 — Final package contents

```
module4/
  redis/connectionFactory.js   (fixed: Bug #2)
  redis/keyspace.js            (unchanged)
  redis/lock.js                (unchanged)
  redis/roomState.js           (unchanged)
  redis/routing.js             (unchanged)
  redis/userProfile.js         (fixed: Bug #1)
  wallet/db.js                 (unchanged)
  wallet/index.js              (fixed: Bug #3, #4, #5)
  wallet/schema.sql            (unchanged)
  tests/regression_tests.js    (path-adjusted for this package's layout)
  tests/mockPg.js
  docs/STEP_4.2_REPORT.md
  docs/STEP_4.3_REPORT.md
  docs/STEP_4.4_REPORT.md
  docs/STEP_4.5_REPORT.md
  docs/MODULE4_FINAL_AUDIT_REPORT.md  (this file)
```

Module 4 remains fully additive: `server.js` and every master-tree Redis
module are untouched. Not merged, not wired into any real request
handler. Ready for Step 4.6 / merge review whenever you want to proceed.
