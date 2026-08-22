# PingPong — Wallet & Economy Audit Report
Date: 2026-07-28 · Scope: Phase 13 follow-up audit on top of existing Phase 9–12 work

## 1. Method
Read every file that mutates coins/diamonds (`server.js`, `coinCenter.js`,
`diamondSeller.js`, `rechargeWithdrawApproval.js`, `approvalEngine.js`,
`agencyHost.js`), traced each mutation to its call site, and checked
atomicity, validation, persistence, and audit-trail completeness against
each one. `agencyHost.js` is read-only reporting (aggregates existing gift
history) — no mutation risk there.

Note: the uploaded `server.js` was already ahead of the one inside the zip
(it had a partial Phase 9 fix the zip didn't). I used the uploaded version
as the base.

## 2. Findings & Fixes

### 🔴 Critical — double-credit via the shared approval engine (FIXED)
**File:** `approvalEngine.js`
The Owner-override rule ("Owner may force ANY transition from ANY status")
had no exception for `approve`. That let `onApprove()` — the hook that
actually credits coins / deducts diamonds for Recharge, Withdraw, VIP
grants, and Diamond Seller approvals — run a second time on a record
already marked `"approved"`. Two ways in:
1. Direct double-click/replay of `approve` by an Owner.
2. `reopen` could pull an *already-approved* record back to `"pending"` —
   after which **any** admin with normal approve permission (no Owner
   needed) could re-trigger the credit.

**Fix:** both `approve` and `reopen` now hard-block once a record is
`"approved"`, for everyone, Owner included. Normal flows (pending → review
→ approve/reject → reopen-from-rejected) are untouched.

### 🟠 High — admin coin-edit endpoint accepted `Infinity` (FIXED)
**File:** `server.js`, `POST /api/admin/users/:mobile/coins`
`isNaN(coins) || coins < 0` does not catch `Infinity` (a legal JS number).
Switched to `Number.isFinite()` and routed the value through the existing
`clampCoinBalance()` ceiling.

### 🟡 Medium — coin/diamond ceiling not applied consistently (FIXED)
Only 2 of ~20 credit sites used the existing `clampCoinBalance()` guard.
Extended coverage to: treasure chest coin/diamond rewards, daily/weekly
rewards, Coin Center sends, Diamond Seller sales (buyer diamonds + seller
commission), and Recharge approval credits. Added a matching
`clampDiamondBalance()` (diamonds had no ceiling at all before this).

### 🟡 Medium — treasure-box endpoints trusted client-supplied `userId` (FIXED)
**File:** `server.js`, `/api/treasure/status`, `/claim-daily`, `/claim-weekly`
These three were never migrated to the session-token auth used elsewhere
(gifts, wallet exchange). Anyone who knew another account's userId could
claim/check their reward. Low theft risk (only ever adds coins) but a real
auth-consistency gap. Migrated to `userAuth.requireUserAuth`; verified the
frontend already sends the bearer token on every call, so **no UI/client
change was needed**.

### 🟡 Medium — audit trail missing required fields (FIXED)
**File:** `server.js`, `logTransaction()`
Records only had `{userId, currency, amount, note, time}` — no transaction
ID, no balance-before/after, no status. Enriched additively (existing
fields unchanged, so nothing that reads the old shape breaks):
`id`, `balanceBefore`, `balanceAfter`, `status: "completed"`.

### 🟡 Medium — audit history silently deleted past 10,000 entries (FIXED)
Old code did `transactions.slice(-10000)`, permanently discarding older
records — not acceptable for a financial audit log. Trimmed entries are now
appended to `transactions_archive.json` before being dropped from the live
file.

### 🟢 Low — stale array reference bug (FIXED, pre-existing)
Trimming used to reassign `transactions = transactions.slice(...)`, but
`analyticsHub.js` holds a direct reference to that array from server
startup. A reassignment (not mutation) would silently freeze analytics at
whatever the array looked like at the first trim. Changed to in-place
`splice()` so all holders of the reference stay in sync.

## 3. Verified already solid (no change needed)
- Gift send (single/multi-recipient/video) — already has pre-mutation
  snapshotting and rollback-on-throw.
- `perf/writeQueue.js` — atomic temp-file+rename, rolling `.bak` backup,
  debounced writes, synchronous flush on graceful shutdown.
- `game-wheel-sync` — already has per-call clamp, per-user cooldown, and a
  rolling 60s cumulative-gain cap (anti-bot).
- Coin Center `sendCoins` — already idempotent via `requestId` replay cache.

## 4. Remaining risks (not fixed — flagging for your call)
- `GET /api/wallet/:userId/transactions` still trusts the URL param with no
  auth — read-only (no money moves), but it does leak a user's financial
  history to anyone who knows their userId.
- Ceiling values (100B coins / 10B diamonds) are generous placeholders —
  fine as a guard rail, not tuned to your actual economy.
- No changes were made to UI, routes' response shapes, or client code —
  backward compatibility preserved throughout.

## 5. Files changed
`server.js`, `approvalEngine.js`, `coinCenter.js`, `diamondSeller.js`,
`rechargeWithdrawApproval.js` — all verified with `node --check`.
