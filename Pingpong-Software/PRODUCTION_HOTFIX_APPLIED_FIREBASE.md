# Production Hotfix — Applied to Firebase-Auth Build

Scope check first: I read through `server.js`'s auth/lookup code before touching
anything. Several of the requested items (B — user lookup stabilization via
`resolveUserKey()`/`normalizeMobile()`, C — Postgres hydration on boot, D —
atomic temp-file-then-rename writes with `.bak` recovery) were **already
implemented** in this uploaded build, from earlier work on this same codebase.
I verified them rather than re-doing them, and only changed what was actually
missing or had a real gap. Firebase Authentication, login flow, tokens, config,
and the login UI/API were not opened.

## A) Mobile Account Migration Fix — new
`mobileMigration.js` (new file), wired into `server.js` right after user
defaults are applied and before the user index is built. Runs once at boot,
mutates `users` in place:
- Old-format phone keys (`+91 98765-43210`, `0123456789 `, etc.) are renamed
  to their canonical `normalizeMobile()` form.
- True duplicates (two raw keys normalizing to the same 10-digit mobile) are
  merged: the richer record (diamonds, followers, verified, populated
  profile) is kept under the canonical key; the other is **archived in full**
  to `data/archived_duplicate_accounts.json`, never deleted.
- `google:<uid>` keys are never read or touched.
- Idempotent — unit-tested by running it twice on the same data; second run
  is a no-op (verified in sandbox, not on your live data).

## B) User Lookup Stabilization — verified, one gap fixed
`resolveUserKey()` / `normalizeMobile()` usage in `server.js` was already
correct. Found and fixed one inconsistent spot: `coinCenter.js`'s
`findUserByIdOrMobile()` only matched an exact raw key. Added a
`normalizeMobile()` fallback (only after the exact match misses, never for
`google:` keys) so an admin typing a number in any format still resolves to
the right account. No API/response shape changed.

## C) Database Hydration Protection — verified, hardened
Boot-time Postgres restore (`scripts/hydrate-from-db.js`) already only fills
in files missing from local disk and never overwrites existing ones. Added a
shape check (must be a real object/array) plus a re-parse of what was just
written before it's renamed into place, so a corrupt Postgres row can't
silently become a "real" local data file — it's skipped and logged instead.

## D) Crash Safe Write System — one real gap fixed
`perf/writeQueue.js` already does atomic temp-file-then-rename writes with a
rolling `.bak`. The gap: its debounce reset on every call, so a file under
*continuous* activity could have its disk write pushed out indefinitely.
Added a 2-second hard ceiling (`MAX_WAIT_MS`) — a file that's been pending
that long flushes on its next tick regardless of ongoing activity.

## E) Coin / Economy Compatibility
Covered by the B fix above (`coinCenter.js` lookup). No economy/calculation
logic touched.

## F) Data Integrity / G) Room System
Reviewed `saveUsers`/room persistence paths — already correct in this build
(atomic writes, `.bak` recovery, room metadata untouched by anything above).
No changes needed.

## Not touched, by design
Firebase config/init/token handling/login callback/verification, login
UI/API, all existing endpoint contracts and response shapes, economy/coin
calculation rules, room ownership/settings/lock state.
