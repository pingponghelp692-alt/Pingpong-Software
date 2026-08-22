# CHANGELOG_FINAL.md — Production Audit Pass, 2026-08-10

## Scope of this pass

Phase 1 (forensic inventory) + targeted, verified fixes for the concrete gaps the inventory surfaced. This was NOT a rewrite pass — per the audit brief's own constraint, room/seat/SFU/voice architecture and all 25 traced wallet mutation call sites were left untouched in their runtime behavior.

## Files inspected

146 JavaScript files + 4 SQL migration files + 8 YAML/config files + 4 HTML entry points + Dockerfile/compose/nginx config. All 146 JS files pass `node --check` (0 syntax errors), before and after this pass.

## Files changed: 3

### 1. `server.js`
- Added `const sharedMiddleware = require("./integration_update/middleware")` (1 new import line).
- Added a global `app.use()` correlation-ID middleware, wired right after `app.use(cors(...))` and before `securityHeaders`. Sets `x-request-id` response header + `req.requestId`/`req.httpRequestId`. Purely additive — no existing route, middleware order, or response shape changed.
- **Why:** Section 10 (Monitoring/Observability) of the audit flagged missing correlation/request IDs. The module that provides this (`integration_update/middleware`) already existed, fully built, but was never required anywhere — a true orphan.
- **Risk:** None identified. Sets a header and one request property; touches no room/seat/wallet/auth code.

### 2. `ai/ai-service.js`
- Added `const { retryJob } = require("./ai-recovery")`.
- Wrapped the single external-provider call (`provider.generate(...)`) in `retryJob(..., 2)` — retries a transient failure up to 2 times before rejecting, same as before, to the caller.
- **Why:** `ai/ai-recovery.js` existed, fully built and self-documented for exactly this use, but was never imported anywhere — dead code. Its use here directly addresses Section 9's requirement that an AI provider outage not break the app outright.
- **Risk:** None identified — the wrapped call is read-only/idempotent (a text-generation API call with no side effects), and every existing caller (`ai-chat.js`, `ai-room-assistant.js`) already catches and shows a graceful fallback message, unchanged.

### 3. `test/run-all.js`
- Extended the test-file discovery to also pick up `integration_update/country_permission/test/*.test.js`, `integration_update/merchant/test/*.test.js`, and `integration_update/module4_wallet_ledger/test/{regression_tests.js,extra_boundary_tests.js}`.
- **Why:** These 3 suites (94 assertions) existed and passed when run directly with `node <file>`, but `npm test` / CI never discovered them since the runner only scanned `./test/`. Confirmed by reading `.github/workflows/ci.yml`, which only runs `npm test`.
- **Risk:** None — purely additive to what gets tested; the existing 18 root suites run exactly as before, in the same order, same process-per-suite isolation.

## Files added: 2

### `scripts/wallet-opening-balance-migration.js`
Opening-balance migration tool for a future Module 4 wallet cutover (see `WALLET_CUTOVER_PLAN.md`). Dry-run by default, idempotent, does not run automatically, does not touch legacy `data/users.json`. Verified against mock data in this pass; **not** run against real data (no live Postgres available in this environment).

### `test/productionAuditWiring.test.js`
8 new regression assertions covering the two wiring changes above: AI retry-then-succeed, AI retry-exhausted-then-reject (bounded, not infinite), correlation-ID generation, and correlation-ID pass-through of an incoming `x-request-id`.

## Files NOT changed (investigated, decision documented)

- `integration_update/admin_updates/index.js`, `integration_update/api/index.js` — read in full, confirmed self-documented as intentionally-unwired optional/additive utilities with no consuming UI yet. Left as-is; forcing a wire-up with nothing to consume it would add risk for no runtime benefit.
- `integration_update/module4_wallet_ledger/**` — traced in full (see `WALLET_CUTOVER_PLAN.md`); confirmed the existing "inactive by design" state is correct and intentional, not a bug. Left untouched. `MODULE4_WALLET_ENABLED` remains `false`.
- All 25 legacy wallet mutation call sites in `server.js`, `coinCenter.js`, `diamondSeller.js`, `callHosting.js`, `rechargeWithdrawApproval.js` — traced and auth-verified, left completely untouched.
- Room/seat/Socket.IO/LiveKit-SFU/voice-mesh code — not touched in this pass at all.

## Test results

Before this pass: `npm test` → 18/18 suites passed (server.js's own root `test/` only; 94 additional assertions existed elsewhere but were invisible to this command).

After this pass: `npm test` → **23/23 suites passed** (18 original + 3 newly-discovered integration_update suites + 1 new suite for this pass's own changes), **all 94 previously-hidden assertions now genuinely run under `npm test` and CI**.

`node scripts/production-preflight.js` → pass (148 JS files syntax-clean).
`node scripts/production-readiness.js` → pass (148 JS files parse cleanly, 10 deployment/core assets present).

## Runtime data hygiene

Running the test suite touches `data/ai_logs.jsonl` and `data/tokens.json` (both grow as tests execute real logging/token code paths). Both were restored to their exact pre-test-run state (verified by MD5 checksum match against the original uploaded ZIP) before packaging the final deliverable — per the explicit instruction not to leave test-run artifacts in source.

## What this pass did NOT attempt (explicitly out of scope, not silently skipped)

- Full endpoint-by-endpoint security matrix (149+ top-level routes in `server.js` alone) — the 25 wallet-mutation routes were spot-checked (see `WALLET_CUTOVER_PLAN.md` §6); the remaining ~124 were not.
- Module 4 wallet cutover itself (Stage 3 of `WALLET_CUTOVER_PLAN.md`) — requires a live Postgres instance and explicit sign-off, neither available here.
- Deployment runbook, disaster-recovery runbook, multi-server validation plan, live-voice acceptance test document — not produced this pass; flagged as remaining work.
- Any change to Voice/LiveKit/SFU, room, or seat logic — explicitly out of scope per the audit brief; not touched.
