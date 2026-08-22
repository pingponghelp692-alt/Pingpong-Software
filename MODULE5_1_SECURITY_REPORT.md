# MODULE 5.1 — Authentication & Session Security — Completion Report

Date: 2026-08-08

## Scope actually completed

Two genuinely-missing gaps identified in the Phase 0 audit; everything
already solid (passwords, OTP TTL, brute-force lockout, admin RBAC,
security headers, token expiry/revocation) was left untouched — no
redundant rework.

## 1. Socket authentication (`server.js`, `public/app.js`)

**Before:** `socket.on("identify", ({ userId }) => ...)` trusted any
client-supplied `userId` with zero verification. Anyone could claim to be
any user over the socket connection — presence, room-join identity, and
everything downstream of `socket.userId` inherited that trust.

**After:** `identify` now optionally accepts `authToken` alongside
`userId`:
- Token present + valid + its real owner's `userId` matches the claim →
  **verified**, `socket.authedUserId` is set for future handlers that
  need to require it.
- Token present but invalid, expired, or belongs to a **different**
  user than claimed → **rejected outright** (`identify-rejected` event,
  `forceLogout: true`). A client that sends a token at all and gets it
  wrong is far more likely an attacker than a legacy client.
- Token absent entirely → accepted as before (**fail open**), but
  logged as unverified. This is the same incremental-rollout philosophy
  already used for `requireUserAuth`'s staged HTTP rollout (see
  `security/userAuth.js`'s own header comments) — it avoids locking out
  any client that hasn't picked up this change yet.

`public/app.js` was updated in the same change to always send its
already-available `authToken` on `identify`, and to handle the new
`identify-rejected` event (mirrors the existing `kicked`/`forceLogout`
handling exactly). Since `api()`/`apiUpload()` already attach
`Authorization: Bearer <token>` to every request automatically, no other
frontend change was needed for the HTTP-side fixes below.

## 2. Unauthenticated identity-mutating endpoints (`server.js`)

**Before:** these endpoints trusted `req.body.userId`/`mobile` directly
as proof of identity — anyone could act as any user by putting a
different id in the request body:

| Endpoint | Risk |
|---|---|
| `POST /api/user/update-profile` | edit any user's name/bio |
| `POST /api/user/upload-photo` | set any user's photo |
| `POST /api/user/follow` / `unfollow` | manipulate any user's follow graph |
| `POST /api/groups/create` | create a group "owned by" any userId |
| `POST /api/groups/:id/icon/upload` | change any group's icon (ownerId check compared against forgeable body field) |
| `POST /api/groups/:id/join` / `leave` | add/remove any userId from any group |
| `DELETE /api/groups/:id` | delete any group by passing its real ownerId in the body |
| `POST /api/room/create` | create a room "hosted by" any userId |
| `POST /api/music/upload`, `/api/room/background/upload`, `/api/room/logo/upload` | anonymous file upload (abuse/storage-exhaustion vector — no specific-user risk, but still ungated) |

**After:** every one of these now requires `userAuth.requireUserAuth`
(the same middleware already proven on the 12 wallet/gift endpoints).
For `update-profile`/`upload-photo`/`follow`/`unfollow`, the existing
`resolveUserKey()` helper already preferred `req.authedMobile` over the
body when present — so adding the middleware alone closed the gap with
no further code change. For the group and room endpoints, identity
(`userId`, `ownerId` comparisons) is now **derived from the verified
`req.authedMobile`** rather than read from the request body at all — the
body's `userId`/`mobile` fields are no longer trusted or even read for
identity in these handlers.

## 3. Files changed

- `server.js` — socket `identify` handler hardened; 10 endpoints gated
  with `requireUserAuth`; identity derivation switched from
  request-body to verified-token for the 6 group/room endpoints.
- `public/app.js` — `identify` emit now sends `authToken`; new
  `identify-rejected` handler added.
- `test/authHardening.test.js` — new, 10 tests against the real
  `security/userAuth.js` module (not a re-implementation): rejects no
  token, rejects forged token, accepts a real token, **confirms a valid
  token can't be used with a forged body identity** (the exact class of
  attack these fixes close), rejects revoked tokens.

No file outside these three was touched — verified via
`diff -rq master PINGPONG_FINAL --exclude=integration_update`.

## 4. Test results

- **New**: `test/authHardening.test.js` — 10/10 passed.
- **Existing, re-run to confirm no regression**: `test/callSignaling.test.js`
  — 13/13 passed. Module 4's regression + boundary suites — 40/40 passed
  (unaffected by this change, re-run anyway for full-project confidence).
- **`node -c`** across all 115+ project files — 0 syntax errors.
- The socket `identify` cross-check branch itself has no dedicated
  isolated unit test — `server.js` is a monolith, not modularized like
  `callSignaling.js`, so exercising that exact handler in isolation
  would require booting the real HTTP+socket server. It was verified by
  direct code reading (shown inline above) and by confirming the full
  existing test suite still passes with the change in place, not by a
  fabricated "socket test."

## 5. What was intentionally left alone (from the Phase 0 audit)

- **No JWT / cookie migration.** This app uses opaque server-side
  tokens (not JWT) and header/body-based tokens (not cookies) by
  design, and that architecture is sound — "JWT security"/"cookie
  security" from the original ask don't map onto a system that doesn't
  use either. Flagged again here in case a literal migration to JWT or
  cookies is actually wanted as separate, deliberate future work — it
  was not done as part of closing this gap.
- **`app.use(cors())` with no origin allowlist** — still open. Not
  touched this pass since restricting it requires knowing the real set
  of legitimate origins (app domain, admin panel domain, any mobile
  WebView origin), which wasn't available to determine safely here.
  Flagged for a future pass with that information.
- **No automatic token revocation on password change.** `revokeAllForMobile`
  exists and works but isn't called from the password-change endpoint.
  Not fixed this pass — flagged, not silently left off the record.
