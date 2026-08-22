# Payment / Recharge -> Coin System (2026-08-16)

## Files changed / created

**New:**
- `wallet/rechargeService.js` — all business logic (settings, packages, transactions, idempotent approve/reject, coin ledger)
- `test/rechargeService.test.js` — 37 assertions covering the mandatory 16-scenario checklist
- `public/index.html` / `public/app.js` / `public/style.css` — user Wallet -> Recharge UI (package grid, payment method cards, UPI/QR pay screen, pending confirmation, recharge history)
- `admin/index.html` / `admin/app.js` / `admin/style.css` — Admin Panel "Payment / Recharge" section (settings form, package CRUD, records table with filters/pagination/approve/reject)
- `docs/PAYMENT_RECHARGE_SYSTEM.md` — this file

**Changed:**
- `server.js` — wired `wallet/rechargeService.js`, added 12 routes (4 user, 8 admin)
- `rbac.js` — added `payment:manage` / `payment:view` / `payment:approve` permissions, granted to appropriate default roles, added `payment-recharge` to `SECTION_PERMISSIONS`

## Payment flow — manual verification, not automatic

**No payment gateway API is integrated anywhere in this codebase.** There
are no PhonePe/Google Pay/UPI merchant credentials in `.env`. PhonePe,
Google Pay, and UPI in the user-facing UI are three ways to pay the same
Owner-configured personal UPI ID — not three separate gateway
integrations. This was a deliberate choice, not a shortcut: without real
merchant API credentials, any code path that marked a payment "verified"
automatically would have to be faking it, which the spec explicitly
forbids (§7, §15).

Real flow:
1. Owner configures UPI ID / receiver name / QR / packages / enabled
   methods in Admin Panel -> Payment / Recharge.
2. User picks a package + method in Wallet -> Recharge, sees the UPI ID/QR,
   pays via their own PhonePe/GPay/UPI app (outside this system), then
   types in the UTR/reference number their payment app gave them.
3. This creates a transaction with `status: "PENDING"` — no coins are
   credited yet, and the UI never claims otherwise.
4. An Admin with `payment:approve` reviews the UTR against their real bank/
   UPI statement in Admin Panel -> Payment / Recharge -> Recharge Records,
   then approves (credits coins) or rejects (adds a reason, credits
   nothing).

## Where to configure things

- **UPI ID / QR / methods / min-max / instructions**: Admin Panel ->
  Payment / Recharge -> Payment / Recharge Settings (`payment:manage`,
  Owner/Global/Country Super Admin by default)
- **Packages (price/coins/bonus/active/order)**: same section, Recharge
  Packages table (`payment:manage`)
- **Transaction records / approve / reject**: same section, Recharge
  Records table (`payment:view` to see, `payment:approve` to act — Country
  Manager+ by default; plain Admin role gets view-only)

## Duplicate-credit prevention (idempotency)

Two independent layers:
1. **Submission-time**: the same UTR+method combination can't be submitted
   as a second live (PENDING/PAID) request — blocks accidental double
   submission from reaching the admin queue twice.
2. **Approval-time (the real guarantee)**: `approveTransaction()` only
   acts on a transaction whose `status === "PENDING"`. The status is
   flipped to `"PAID"` and persisted to disk *before* the coin balance is
   mutated. A second call on the same transaction id — a double-click, a
   retried request, two admins racing — sees a non-PENDING status and is a
   no-op that returns the existing record instead of crediting again. This
   is what the "5 rapid approve calls -> exactly 1 credit" test in
   `rechargeService.test.js` (#13) verifies directly.

## Coin ledger

Every successful credit writes an append-only entry to
`data/coinLedger.json`: `userId`, `mobile`, `txnId`, `amountCoins`,
`balanceBefore`, `balanceAfter`, `timestamp`, `adminId`. This is
independent of the transaction record itself, so it can be reconciled
against it. No function in this module writes to `user.coins` outside of
`approveTransaction()`.

## Existing wallet system — untouched

This is fully additive. `rechargeWithdrawApproval.js` (the existing
Admin-initiated manual recharge/withdraw approval workflow) is unchanged
and still works exactly as before — this module is the separate
*user-initiated* counterpart. Gifts, rooms, voice, users, authentication,
sessions, profiles, and every other existing wallet operation
(`clampCoinBalance`, `logTransaction`, `pushWalletUpdate`, instant
exchange, coin sellers, diamond seller) are untouched — confirmed by
`diff -rq` against the pre-change codebase showing only the files listed
above differ.

## Test results

- `node test/rechargeService.test.js` — **37/37 passed**, covering all 16
  mandatory scenarios from the spec (successful/failed/cancelled/pending
  recharge, admin approve/reject, duplicate-UTR + duplicate-approve
  idempotency, wrong/malformed UTR rejection, ownership isolation,
  balance-before/after ledger correctness, 5x simultaneous-approval race,
  disabled-payments guard, inactive-package guard).
- `node test/run-all.js` (full project suite) — **31/31 suites passed**
  (30 pre-existing + this one), confirming no regression in auth, rooms,
  voice/SFU, redis clustering, or any other existing system.

## Known limitation — not testable in this environment

This sandbox has no network access, so `npm install` cannot fetch
`express` and the other runtime dependencies — the server itself was
never booted to do live HTTP request/response testing. Every route added
follows the exact same `requireAdmin` / `requirePermission` /
`userAuth.requireUserAuth` patterns as this project's existing,
already-tested routes, and both new/edited JS files pass `node --check`.
All business-logic verification (idempotency, ledger correctness, access
control) was done by testing `wallet/rechargeService.js` directly — the
same approach this project's own test suite already uses for every other
module (e.g. `test/authHardening.test.js`, `test/otpService.test.js`),
none of which spin up a live Express server either. Before going live,
run a real end-to-end test against a running instance with a real UPI
payment.
