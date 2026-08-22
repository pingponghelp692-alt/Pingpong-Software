# WALLET_CUTOVER_PLAN.md

Status as of 2026-08-10: **Module 4 wallet ledger remains INACTIVE.** `MODULE4_WALLET_ENABLED=false` in `.env.example`, `integration_update/module4_wallet_ledger/index.js` is not required by `server.js`. This document traces the current legacy call sites and lays out the staged, reversible path to cut over — it does **not** perform the cutover itself. No live Postgres instance exists in this environment to test a real cutover against, so flipping the switch here would be exactly the kind of unverified, untested change the audit brief prohibits.

## 1. Why it's still off (verified, not assumed)

`integration_update/module4_wallet_ledger/index.js`'s own header documents this explicitly — I read it, not just the summary reports:

> "this folder is never required automatically by server.js, and nothing in it touches server.js's live user.coins / user.diamonds / logTransaction code paths... Flipping wallet authority over to this module means: standing up real Postgres for it, migrating every existing user's live coins/diamonds balances into module4_wallet_balances, and rewriting every one of those 10+ call sites in the same change — a real data migration, not a code merge."

Confirmed by grep: zero occurrences of `module4` or `wallet_ledger` anywhere in `server.js`.

## 2. Legacy wallet mutation call sites — traced

Method: `grep -nE "\.coins ?[+-]?=|\.diamonds ?[+-]?="` across every `.js` file outside `node_modules`/`test`, then manually inspected each hit's surrounding code to exclude analytics/reporting aggregations (which use the same property names on unrelated accumulator objects, not live user balances).

**25 real user-balance mutation sites found** across 5 files:

| # | File:Line | Trigger | Currency |
|---|---|---|---|
| 1 | server.js:1341 | Treasure chest reward | coins |
| 2 | server.js:1345 | Treasure chest reward | diamonds |
| 3 | server.js:2282 | Gift send (sender debit) | coins |
| 4 | server.js:2287 | Gift receive (recipient credit) | diamonds |
| 5 | server.js:3338 | Instant diamond→coin exchange (debit) | diamonds |
| 6 | server.js:3339 | Instant diamond→coin exchange (credit) | coins |
| 7 | server.js:3384 | Daily reward | coins |
| 8 | server.js:3400 | Weekly reward | coins |
| 9 | server.js:4612 | Admin direct coin-balance edit | coins |
| 10 | server.js:4864 | Admin exchange decision (debit) | diamonds |
| 11 | server.js:4866 | Admin exchange decision (credit) | coins |
| 12 | server.js:5124 | Fruit Wheel restart refund | coins |
| 13 | server.js:5266 | Fruit Wheel payout | coins |
| 14 | server.js:5794 | Multi-target gift send (sender debit) | coins |
| 15 | server.js:5801 | Multi-target gift receive | diamonds |
| 16 | server.js:5874 | Gift send, socket variant (sender debit) | coins |
| 17 | server.js:6416 | Fruit Wheel bet | coins |
| 18 | server.js:6507 | Game-wheel sync correction | coins |
| 19 | coinCenter.js:144 | Coin Center single send | coins |
| 20 | coinCenter.js:327 | Coin Center bulk send | coins |
| 21 | diamondSeller.js:370 | Diamond seller sale (buyer credit) | diamonds |
| 22 | diamondSeller.js:371 | Diamond seller commission | coins |
| 23 | callHosting.js:270 | Per-minute call billing | coins |
| 24 | rechargeWithdrawApproval.js:83 | Recharge approval | coins |
| 25 | rechargeWithdrawApproval.js:124 | Withdraw approval (debit) | diamonds |

**Excluded as false positives** (same property names, different meaning — verified by reading context, not just the grep line):
- `server.js:1110`, `agencyHost.js:64-67` — leaderboard/ranking totals objects (`totals[senderId].diamonds`), not live balances.
- `analyticsHub.js:97-100`, `callHosting.js:198` — analytics report buckets (`bucket.recharge.coins`, `stats.byDay[day].coins`), not live balances.

**Known limitation of this trace:** this method finds direct `.coins`/`.diamonds` property mutations. It would miss a hypothetical mutation reached only through a helper function that takes the property name as a dynamic string/bracket-notation (`user[currency] += x`). A targeted secondary pass for that pattern is recommended before an actual cutover; none was found in this pass but the possibility isn't fully ruled out for a 6,697-line server.js.

## 3. Staged cutover path

```
Stage 0 (DONE, pre-existing): Module 4 built + unit tested against mock Postgres
    ↓
Stage 1 (DONE, this pass): Call-site trace above + opening-balance migration
    tooling built (scripts/wallet-opening-balance-migration.js) — dry-run
    verified against mock data, NOT run against real data (none exists here)
    ↓
Stage 2 (EXTERNAL VALIDATION REQUIRED): Stand up a real staging Postgres,
    run integration_update/module4_wallet_ledger/migrations/001_*.sql and
    wallet/schema.sql, then:
      node scripts/wallet-opening-balance-migration.js --execute
    against a STAGING COPY of data/users.json. Inspect the generated
    migration-report-*.json — every entry must show status "reconciled"
    with matches:true before proceeding.
    ↓
Stage 3 (NOT DONE — requires explicit sign-off + Stage 2 evidence):
    Rewrite all 25 call sites above, one at a time, each behind the
    existing MODULE4_WALLET_ENABLED flag, e.g.:
        if (MODULE4_WALLET_ENABLED) {
            await module4Wallet.wallet.credit({ userId, currency: "coins", amount, txnId, reason });
        } else {
            found.user.coins = clampCoinBalance(...);  // existing path, unchanged
        }
    This lets the flag be flipped back instantly (Stage 4) without a
    second code deploy if something looks wrong in staging/canary.
    ↓
Stage 4 (rollback plan): MODULE4_WALLET_ENABLED=false reverts every call
    site to the legacy path immediately. Legacy data/users.json is never
    deleted or overwritten by any of this — it remains the fallback source
    of truth until Module 4 has run in production, matching balances,
    for an agreed observation period (recommend: minimum 2 weeks with
    daily reconcileBalance() checks logged, zero unresolved drift).
    ↓
Stage 5 (final): Only after Stage 4's observation period is clean, retire
    the legacy .coins/.diamonds fields as source of truth. This is a
    separate, later decision — out of scope for this pass.
```

## 4. What this pass did NOT do, and why

- **Did not set `MODULE4_WALLET_ENABLED=true`.** No live Postgres exists here to validate against; flipping it would be an unverified change to how real money-equivalent balances are computed.
- **Did not rewrite the 25 call sites.** Per the audit brief's explicit rule ("কখনো existing balances silently overwrite করবে না") and Stage 3's dependency on Stage 2 evidence that doesn't exist yet.
- **Did build and dry-run-verify the migration script** (`scripts/wallet-opening-balance-migration.js`) — idempotent (checked via deterministic txnId + `getTransaction()` lookup before writing), read-only against legacy data, reconciles every entry it seeds, writes a JSON audit report, defaults to dry-run, refuses to run without `MODULE4_WALLET_DATABASE_URL` explicitly set.

## 6. Auth spot-check on all 25 traced call sites (2026-08-10)

Every call site above was traced back to its trigger:

| Trigger type | Sites | Verified gating |
|---|---|---|
| HTTP routes (`/api/gifts/send`, `/api/wallet/exchange-instant`, `/api/treasure/claim-daily`, `/api/treasure/claim-weekly`) | 6 | `userAuth.requireUserAuth` |
| Admin HTTP routes (`/api/admin/users/:mobile/coins`, `/api/admin/exchanges/:id/decide`, coinCenter, diamondSeller, rechargeWithdraw endpoints) | ~10 | `requireAdmin` + `requirePermission("<specific>")` |
| Socket.IO events (`send-gift`, `send-video-gift`, `fruitwheel-bet`, `game-wheel-sync`) | 6 | Socket-level auth (`socket.userId` set at connection time via the same token verification as HTTP) + in-handler room-membership checks |
| Server-internal only, never client-reachable (`applyChestReward` triggered from already-authed gift handlers; `fwRecoverRoundsOnBoot` runs once at process startup from persisted disk state; fruit-wheel-payout runs from the server's own round timer, not a request handler) | 3 | N/A — not a request-triggered code path, so no separate authorization gate is applicable |

No authorization gap found in this pass across the 25 traced wallet-mutation sites. This does not constitute a full endpoint security audit of the other ~124 non-wallet routes in server.js — see FINAL_PRODUCTION_AUDIT_REPORT.md for that scope note.

## 5. EXTERNAL VALIDATION REQUIRED (explicit list)

- Running migrations SQL against a real Postgres instance.
- Running `wallet-opening-balance-migration.js --execute` against real (staging, then production) `data/users.json` and inspecting the reconciliation report.
- Load-testing Module 4's concurrency/locking behavior under real concurrent traffic (unit tests already cover the logic with a mock Postgres — see `integration_update/module4_wallet_ledger/test/`, 40 assertions passing — but that is not the same as production concurrency).
- The Stage 3 canary rollout itself.
