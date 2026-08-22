# FIREBASE / IDENTITY — PHASE 1 AUDIT
Date: 2026-08-10
Scope: Login, OTP, Firebase token verification, session/token handling, token
refresh, account linking, mobile/account migration, user identity mapping,
HTTP auth, socket auth, auth→authz boundary.

Baseline respected: no room/seat/voice/SFU/wallet runtime behavior changed.
Only the one concrete defect below (AUTH-1) was fixed, plus its regression
test. Everything else in this report is VERIFIED / NO ISSUE.

---

## AUTH-1 — join-room socket event let a verified socket claim a different identity (FIXED)

**file:line (before fix):** `server.js:5521` (`socket.on("join-room", ...)`)

**Current behavior (before fix):** The `identify` socket event (Module 5.1,
2026-08-08) verifies a claimed `userId` against `authToken` and sets
`socket.authedUserId` on success. `join-room`, however, set
`socket.userId = userId` directly from its own client-supplied payload
(`public/app.js:1604,1986` never send `authToken` on `join-room` at all),
with **no check against `socket.authedUserId`**. `socket.userId` is what
every other room handler trusts downstream — `send-message`, `take-seat`,
gift sends, and critically `isOwnerOrAdmin(room, socket.userId)`, which
gates every mod/host action (kick, mute, lock, ban, close-room, etc.).

**Risk:** A socket — verified or not — could emit `join-room` claiming any
`userId`, including a room's own host, and every subsequent action on that
socket in that room would be authorized as the claimed identity. This is
the exact class of impersonation the `identify` hardening (Module 5.1)
was written to close, but the fix was never extended to `join-room`, which
is the event that actually sets the identity used for room authorization.
`socket.authedUserId` was set by `identify` but never read anywhere.

**Fix applied:** New module `security/socketIdentity.js` exports a pure,
unit-tested guard `isJoinIdentityAllowed(authedUserId, claimedUserId)`.
Wired into `server.js`'s `join-room` handler: if the socket already has a
verified `authedUserId` (i.e. it called `identify` with a valid token this
connection) and now tries to join as a **different** `userId`, the join is
rejected and the socket receives the same `identify-rejected` /
`forceLogout` response `identify` itself sends on a mismatch. A socket
that never verified (no prior `identify`, or a legacy client that never
sends `authToken`) is still accepted unverified — unchanged from prior
behavior, so no legacy client is locked out.

**Test/evidence:** `test/socketIdentityGuard.test.js` (6/6 passing),
covering: legacy unverified pass-through, self-join allowed, mismatched
userId rejected, empty-claim rejected, and the concrete exploit scenario
(verified attacker claiming a room host's userId). Full suite re-run after
the fix: **24/24 suites passing** (23 pre-existing + this one), `node
--check server.js` clean. No other file changed.

**Residual/accepted risk:** A socket that never calls `identify` at all
(no `authedUserId` ever set) remains as unauthenticated on `join-room` as
it was before this fix — this preserves the existing fail-open policy for
legacy clients and is unchanged by this fix. Every current first-party
client (`public/app.js:838`) does call `identify` with `authToken`
immediately after connecting, so this residual gap only affects
not-yet-updated third-party/legacy clients, exactly as documented for the
`identify` hardening itself.

---

## Verified, no issue found

### 1–2. Login / OTP generation
`server.js` `/api/auth/send-otp`, `/api/auth/verify-otp` — OTP is
server-generated (`Math.floor(100000+Math.random()*900000)`), stored
server-side keyed to the normalized mobile, never echoed back except via
the server console log (dev-mode SMS stand-in). Brute-force lockout via
`security/bruteForce.js` keyed to `otp:<mobile>`, with expiry handling
that treats a stale OTP as not-found rather than a guessable wrong-answer.
No client-supplied OTP-bypass path found.

### 3. Firebase token verification
`security/firebaseAuth.js` — real `admin.auth().verifyIdToken(idToken,
true)` call (checkRevoked:true), fails closed if Firebase Admin isn't
configured (`firebaseReady` gate), throws the real firebase-admin error
code rather than swallowing it. Project-ID mismatch between the service
account and the client's Firebase project is explicitly detected and
logged at startup. No bypass path — every code path either returns a
verified `decoded` token or throws.

### 4. Session/token handling
`security/userAuth.js` — opaque 32-byte random tokens
(`crypto.randomBytes(32)`), server-side `Map` + debounced disk persistence,
idle (7d) + absolute (30d) expiry enforced on every validate, revocation
support (`revokeToken`, `revokeAllForMobile`). `requireUserAuth` resolves
identity from the `Authorization: Bearer` header (or `body.authToken`
fallback) only — never trusts `body.mobile`/`body.userId` as identity.

### 5. Token refresh
Firebase-side refresh is client-driven (`getIdToken(true)` per
`security/firebaseAuth.js`'s comments); server distinguishes
`auth/id-token-expired` from other failure codes so the client can
silently retry once with a force-refreshed token instead of showing an
error. App-session tokens use "refresh on use" (idle clock resets on every
valid `validateToken()` call) rather than a separate refresh endpoint —
consistent, no gap found.

### 6–7. Account linking / mobile migration
`server.js`'s `/api/auth/firebase-login` branches explicitly on
`decoded.firebase.sign_in_provider` (not merely the presence of a phone
number) to decide whether to resolve/create by normalized phone or by
`google:<uid>`. `data/firebaseLinks.json` mapping is populated only from
the server-verified `uid`, never from client input, so an attacker cannot
attach a Firebase UID to an arbitrary existing account. `mobileMigration.js`
runs once at boot, server-side only, on server-held data — no
attacker-controlled input path, never touches `google:` keys, never
deletes data (archives duplicates instead).

### 8. User identity mapping
`resolveUserKey(req)` (server.js:1545) prioritizes `req.authedMobile`
(server-verified) over any client-supplied `body`/`params`/`query.mobile`.
Audited all 27 call sites of `resolveUserKey(req)` in server.js: every one
is behind either `userAuth.requireUserAuth` (so `req.authedMobile` is
always set and the client-supplied fallback is unreachable) or
`requireAdmin` + `requirePermission` (where the `:mobile` param is the
*target* of an admin action, not the actor's own claimed identity — actor
identity there comes from `req.adminAccount`, resolved server-side from
the admin session token). No route found where an unauthenticated request
can set its own identity via `resolveUserKey`'s fallback.

### 9. HTTP authentication
Consistent pattern project-wide: `Authorization: Bearer <token>` →
`userAuth.validateToken()` → `req.authedMobile`. No endpoint found that
accepts a client-supplied `mobile`/`userId` as authoritative identity
without a prior `requireUserAuth` gate (see item 8). Own-resource checks
(e.g. `/api/user/:userId/recent-rooms`, `/agency/:userId`, `/inbox/:userId`)
consistently compare `actor.userId !== req.params.userId` using the
*actor* resolved from the verified token, not the URL param, before
returning data.

### 10. Socket authentication
`identify` event (server.js:5428) verifies `authToken` via
`userAuth.validateToken`/`validateTokenCrossInstance` and cross-checks the
token's owner's `mobile` against the claimed `userId` before setting
`socket.authedUserId` — rejects outright on a present-but-invalid/
mismatched token, fails open only when no token is sent at all (documented
legacy-client accommodation). See AUTH-1 above for the one gap found and
fixed in how this verified state was (not) propagated to `join-room`.

### 11. Auth → authorization boundary
Admin authorization (`requireAdmin` → `requirePermission` →
`requireCountryScope`/`requireRoomScope`) consistently derives the actor
from the server-side `adminSessions` Map + `rbac.findById()`, never from
client-supplied role/permission/country claims — role/country escalation
via request body was not found to be possible. `requirePermission` and
`requireCountryScope` log every denial as a `failed` audit entry with the
attempted permission/country, satisfying the audit-trail requirement.
Admin session expiry (`security/session.js`: 30 min idle / 12h absolute) is
enforced on every `requireAdmin` call via `adminSessionGuard.touch()`.

---

## Summary

| Item | Status |
|---|---|
| Authentication bypass | 1 found (AUTH-1) — **fixed** |
| Client-supplied userId trusted as server identity | 1 found (AUTH-1, socket layer only) — **fixed**; HTTP layer verified clean |
| Token verification actually performed | Verified |
| Expired/invalid tokens rejected | Verified |
| Account linking cannot attach to wrong identity | Verified |
| Socket identity from verified auth | Fixed (AUTH-1) |
| Admin identity cannot be spoofed | Verified |
| Country/role escalation via client input | Verified — not possible |

**Files changed:** `server.js` (+13 lines, `join-room` handler + 1 require),
`security/socketIdentity.js` (new), `test/socketIdentityGuard.test.js` (new).
**Tests:** 24/24 suites passing (was 23/23; +1 new suite, 6 new assertions).
No room/seat/voice/SFU/wallet runtime behavior changed beyond this one
identity check.
