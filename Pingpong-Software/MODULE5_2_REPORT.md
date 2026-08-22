# Module 5.2 — API, Input & Abuse Protection — Completion Report

Continuation of Module 5.1 (Authentication & Session Security). Module 5.1's
changes (`server.js`, `public/app.js`, `test/authHardening.test.js`) are
preserved unmodified in this delivery. This module implements the four
items agreed after the Step 1 audit only — CORS, socket moderation rate
limiting, query/params validation, and documentation. No other area was
touched.

---

## 1. Audit findings (recap)

Full detail was given before implementation began; summary:

| Area | Status before 5.2 |
|---|---|
| Auth (Module 5.1) | Already hardened — untouched here |
| Rate limiting (HTTP) | Already solid — `apiLimiter` blankets `/api/*`, plus tighter limiters on OTP/login/admin-login |
| Input validation (chat/bio/amounts/filenames) | Already solid |
| Uploads | Already solid — size caps, MIME filters, safe filenames, auth-gated |
| Security headers / CSP | Already solid |
| XSS | Already solid — consistent `escapeHtml()` usage |
| CORS | **Missing** — `app.use(cors())` fully open, no allowlist, no Socket.IO `cors` config |
| Socket admin/host moderation rate limiting | **Missing** — authorization existed, no rate limit |
| Query/params validation | **Partially covered** — most numeric/pagination params already bounded; found one real gap (see below) |
| CSRF | **Not applicable** — token-based auth, no cookies |
| Password-change session revocation | **Not applicable** — no password-change endpoint exists |

---

## 2. Changes made

### A. Env-driven CORS (new file: `security/corsConfig.js`)
- Single shared allowlist (`CORS_ORIGINS`, comma-separated) used by **both**
  Express's `cors()` and Socket.IO's `cors` option — can't drift apart.
- No production domain guessed or hard-coded — nothing in the supplied
  project states what it is.
- Requests with **no** `Origin` header (same-origin page loads, the mobile
  app's native HTTP client, curl, server-to-server calls) are always
  allowed — none of those ever send this header, so this changes nothing
  about the existing mobile/same-origin flow.
- If `CORS_ORIGINS` is **unset**: cross-origin *browser* requests are only
  allowed from `localhost`/`127.0.0.1` (any port) — safe by default,
  supports local dev (frontend on a different port than the API), and
  replaces the previous fully-open `cors()` without needing to know the
  real prod origin today.
- `server.js`: `app.use(cors())` → `app.use(cors(httpCorsOptions))`;
  `socket.io` server construction now passes `cors: socketIoCorsOptions`.

### B. Socket admin/host moderation rate limiting
- New `isModActionRateLimited(userId)` in `server.js`, a thin wrapper
  around the **existing** `aiSecurity.isRateLimited()` (the same module
  already used for chat-flood and emoji-reaction spam — no new/duplicate
  rate-limit system).
- One shared key per user (`mod-action:<userId>`) across all moderation
  actions, not per-event, so a host doing legitimate rapid bulk moderation
  (mute 10 people, then chat-ban one) isn't artificially split into small
  per-action buckets.
- Limit: 20 actions / 5 seconds — generous, well beyond any real human or
  bulk-UI moderation pace, well below spam/DoS territory.
- Applied to the 9 previously-unthrottled events, each as one added guard
  line placed **after** the existing, unmodified authorization check:
  `kick-user`, `set-admin`, `mod-mute-users`, `mod-chat-ban`,
  `mod-invite-to-seat`, `mod-move-seat`, `mod-move-to-audience`,
  `mod-label-users`, `mod-announce-users`.
- No authorization logic changed anywhere.

### C. Query/params validation
- Audited all 74 `req.query`/`req.params` sites in `server.js`. Most were
  already properly bounded (pagination clamped, SVIP level range-checked,
  amounts validated via `isValidAmount`-style integer checks in
  `coinCenter.js`, etc.) — no changes needed there.
- Found one genuine, real gap: several routes did a raw bracket lookup —
  `rooms[req.params.roomId]`, `groupsStore[req.params.groupId]` — directly
  against a plain in-memory object. A plain `{}` still inherits from
  `Object.prototype`, so a request with `roomId`/`groupId` literally set to
  `"__proto__"`, `"constructor"`, or `"prototype"` makes the lookup resolve
  to a real, truthy object instead of `undefined`, bypassing the route's
  usual `if (!found) return "not found"` guard. This was **not** an
  exploitable prototype-pollution *write* (no route ever does
  `store[req.params.x] = ...`), but it is a real input-format-validation
  gap that could produce incorrect behavior or an unhandled exception on a
  route that doesn't re-check every expected field.
- Fix: new `isSafeObjectKey()` in `security/validation.js` (type + length +
  denylist check), plus `safeRoomLookup()` / `safeGroupLookup()` wrapper
  helpers in `server.js`. All 6 `groupsStore[...]` sites (including the one
  `delete`) and all 7 `rooms[...]` sites (including the one `delete`) now
  go through these wrappers. Real, well-formed roomId/groupId values behave
  identically to before — this only changes behavior for the
  dangerous-key edge case.

### D. Documentation
- **CSRF**: recorded as not applicable. The app authenticates via an opaque
  header/body token (`security/userAuth.js`), never via a cookie-based
  session — confirmed no `express.urlencoded`/cookie-session middleware
  exists anywhere in the project. CSRF is a cookie-auth vulnerability
  class; adding CSRF-token middleware here would add complexity with no
  actual protection benefit, so none was added.
- **Password-change session revocation**: recorded as not applicable.
  `security/userAuth.js` exports `revokeAllForMobile()`, but it is never
  called anywhere in the project — because there is no "change password"
  endpoint to call it from. `/api/auth/set-password` is explicitly
  set-once by design (it rejects with "A password is already set for this
  number" if `passwordHash` already exists). There is nothing to wire
  `revokeAllForMobile()` into without building a new change-password
  flow, which is new-feature scope outside Module 5.2. If a change-password
  endpoint is added in a future module, it should call
  `userAuth.revokeAllForMobile(mobile)` after a successful change so
  existing sessions are invalidated — noted here for whoever builds it.

---

## 3. Files changed

- **New**: `security/corsConfig.js`
- **New**: `test/corsConfig.test.js`
- **New**: `test/modActionRateLimit.test.js`
- **New**: `test/paramsValidation.test.js`
- **New**: `MODULE5_2_REPORT.md` (this file)
- **Modified**: `server.js` — CORS wiring (HTTP + Socket.IO), 9 moderation
  event rate-limit guards, `isModActionRateLimited()`/`safeRoomLookup()`/
  `safeGroupLookup()` helpers, 13 room/group lookup sites converted to the
  safe wrappers
- **Modified**: `security/validation.js` — added `isSafeObjectKey()`

`public/app.js`, `callSignaling.js`, and every other file are unchanged
from the Module 5.1 delivery.

---

## 4. Test results (all actually run, not assumed)

Sandbox note: this environment has no network egress, so `npm install`
cannot fetch the project's real dependencies (express, socket.io, cors,
multer, etc. are not present locally) — the same limitation noted on every
prior module in this project that needed live-service testing (e.g. the
SFU work's "no real LiveKit server" gap). All of this project's actual test
files, including the three new ones, are deliberately dependency-free
(mock req/res or exercise the real underlying module directly) specifically
so they *can* run for real here — and they did.

| Suite | Result |
|---|---|
| `test/authHardening.test.js` (Module 5.1 regression) | **10/10 passed** |
| `test/callSignaling.test.js` (Module 5.1 regression) | **13/13 passed** |
| `integration_update/module4_wallet_ledger/test/regression_tests.js` | **23/23 passed** |
| `integration_update/module4_wallet_ledger/test/extra_boundary_tests.js` | **17/17 passed** |
| `integration_update/country_permission/test/countryPermission.test.js` | **17/17 passed** |
| `integration_update/merchant/test/merchant.test.js` | **14/14 passed** |
| `test/corsConfig.test.js` (new) | **26/26 passed** |
| `test/modActionRateLimit.test.js` (new) | **6/6 passed** |
| `test/paramsValidation.test.js` (new) | **18/18 passed** |
| `node -c` syntax check, every `.js` file in the project | **120/120 clean, 0 errors** |

Baseline was captured with the identical suites **before** any Module 5.2
change was made, and matches these post-change numbers exactly (same pass
counts) — confirming no regression.

### What the new tests could and couldn't exercise directly
- `corsConfig.test.js` requires and calls the real `security/corsConfig.js`
  functions directly — full coverage, no mocking of the logic itself.
- `modActionRateLimit.test.js` and `paramsValidation.test.js` exercise the
  real underlying primitives (`ai/ai-security.js`'s `isRateLimited()`, and
  `security/validation.js`'s `isSafeObjectKey()`) with the exact
  key/window/max and guard logic `server.js` uses — because `server.js`
  itself can't be `require()`'d standalone without its full dependency
  tree installed. This is disclosed in each test file's header comment.
  The one-line wrappers in `server.js` around these primitives
  (`isModActionRateLimited`, `safeRoomLookup`, `safeGroupLookup`) have no
  branching logic of their own beyond calling straight through, so this
  is real coverage of the behavior that matters, short of a live
  end-to-end socket/HTTP run.

---

## 5. Remaining / deferred security items (not part of this module)

- **CORS_ORIGINS still needs to be set in production `.env`** — with it
  unset, the safe default (localhost-only cross-origin) will correctly
  allow the mobile app and same-origin web traffic, but will **not** allow
  a separately-hosted production web frontend (if one exists) to call this
  API cross-origin until the real domain is configured.
- **No real-dependency end-to-end test of the CORS/Socket.IO wiring**
  itself (i.e. an actual HTTP request hitting `cors(httpCorsOptions)`, or a
  real Socket.IO handshake against `socketIoCorsOptions`) — blocked by this
  sandbox's lack of network egress to install express/socket.io. The pure
  logic those options are built from is fully tested (above).
- **General per-IP/per-socket connection-rate throttle on new Socket.IO
  connections** — noted in the original audit's "C. Actually missing" list,
  not part of the four items scoped for this module; still open.
- **Password-change flow** does not exist at all (by design, per the
  original spec) — not a Module 5.2 gap, just re-flagged here since it's
  the reason item D's second point is N/A rather than fixed.
- Everything else flagged as already-secure/partially-secure in the Step 1
  audit that wasn't in this module's four-item scope (broader socket
  payload shape validation beyond the room/group ID keys, connection-level
  abuse protection, etc.) remains as it was — untouched, per the
  instruction to implement only these four areas.

---

Module 5.2 is complete per the agreed scope. **Stopping here — not
proceeding to Module 5.3 or 5.4.**
