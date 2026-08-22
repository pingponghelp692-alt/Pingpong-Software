# Root Cause Fix — 2026-08-04

## 1. "Invalid or expired Firebase session — please sign in again" (every login)

**Root cause:** the server had no Firebase Admin credentials configured at
all — no `.env` file existed, so `security/firebaseAuth.js` was never able
to initialize `firebase-admin`, and `verifyFirebaseToken()` rejected
**every** login attempt (not just expired ones) with the same generic
message.

**Fix:**
- `.env` created with `FIREBASE_SERVICE_ACCOUNT_BASE64` set from the
  service account you provided (project `ping-pong-voice-chat-24a27`,
  matches the client config in `public/firebaseClient.js` — no
  project-mismatch issue).
- `.gitignore` added (`.env`, `node_modules/`, `data/*.json`) so the key
  never accidentally gets committed.
- `security/firebaseAuth.js`: verification failures now carry the real
  Firebase error `code` (`server/not-configured`, `auth/id-token-expired`,
  `auth/id-token-revoked`, etc.) instead of always reading as the same
  generic condition. Every failure is logged to the server console with its
  exact code (requirement #12).
- `server.js` (`/api/auth/firebase-login`): branches on that code to return
  a specific, correct message — and a machine-readable `code` field the
  client uses to decide whether a silent retry makes sense.
- `public/firebaseClient.js`:
  - `verifyPhoneOtp()` / `signInWithGoogle()` now call `getIdToken(true)` —
    always a freshly-minted token, never a cached one (requirement #7).
  - New `getFreshIdTokenIfPossible()` — silently force-refreshes the
    current Firebase user's token with no error shown.
  - New `fullFirebaseSignOut()` — signs out of Firebase and sweeps every
    `firebase:`-prefixed `localStorage`/`sessionStorage` key so a dead
    session can never linger into the next attempt (requirement #4).
  - `onAuthStateChanged` wired up for diagnostics + safety cleanup of any
    in-flight OTP confirmation if the Firebase user disappears
    (requirement #6).
- `public/app.js` (`finishFirebaseLogin`): if the server reports
  `code: "token-expired"`, the client now silently force-refreshes and
  retries **once** before ever showing the user anything (requirements #3,
  #5). If the retry also fails (or no refresh is possible), the Firebase
  session is fully torn down via `fullFirebaseSignOut()` before the error
  is shown, so the next attempt starts clean.
- `clearSession()` in `app.js` now also calls `fullFirebaseSignOut()`, so a
  normal app logout clears Firebase's own cached session too, not just this
  app's `pp_user`/`pp_auth_token`.

**Not touched (already correct):** script load order in `public/index.html`
(Firebase SDK → `firebaseClient.js` → `app.js`, all synchronous, no
`async`/`defer` — no race condition there), Google/Phone provider code
paths, `checkRevoked: true` on `verifyIdToken`, the old OTP/password login
endpoints (fully independent, untouched), and all room/coin/game features.

Cache-busting `?v=` bumped on `app.js`, `firebaseClient.js`, and
`style.css` in `public/index.html` so this fix actually reaches phones that
have the old files cached (see `FIREBASE_LOGIN_CSP_FIX.md` for why this
matters on this deployment).

---

## 2. Seat icons (Live Room, seats 1–8)

Empty-seat placeholder changed from a plain "＋" text glyph to the supplied
mic icon (`public/images/icons/icon-seat-mic.png`, resized/optimized to
240×240). Seat circle size reduced slightly (`.seat-circle` 88% → 80% of
the grid cell) for better visual balance. Occupied seats (user photo, VIP
ring, role/mute badges) are untouched — only the empty-seat visual changed.

## 3. Game wallet icon (Fruit Wheel)

The Fruit Wheel game bundle (`public/foodwheel/index.html`) was displaying
a 💎 diamond emoji next to the balance/leaderboard/exit-dialog numbers, even
though that balance is always `me.coins` (coins), never diamonds — see
`FOODWHEEL_INIT`/`TEENPATTI_INIT` in `app.js`, which have always sent
`balance: me.coins`. All 5 occurrences replaced with 🪙. Teen Patti
(`public/teenpatti/index.html`) did not use a diamond icon and was not
changed. No other icons (room icons, coin icon elsewhere in the app) were
touched, per request.
