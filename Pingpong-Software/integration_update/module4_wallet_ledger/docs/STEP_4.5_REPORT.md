# Module 4 — Step 4.5 Report: Distributed User Profile (final Step 4.1 entity)

## Existing source of truth inspected before writing code

- `server.js`'s `users` object (`let users = safeRead(USERS_FILE, {})`)
  remains authoritative — this step does not change that, unlike Step
  4.4's wallet migration where Postgres became genuinely authoritative.
- `POST /api/user/complete-profile` ("Create Your Profile" screen) —
  identified the fields a user actually edits as their profile:
  `name`, `gender`, `country`, `language`, `profile_completed`.
- `publicRoom()`'s seat-mapping code — identified the fields server.js
  *already* re-reads live from the user record on every request, with
  an explicit comment explaining why ("so a frame/VIP change shows up
  on the seat instantly"): `activeFrame`, `vipLevel`, `customTag`,
  `nameEffect`. This is the concrete cross-instance correctness gap
  this step exists to close — see the file header for the full
  reasoning.
- `redis/userState.js` (existing Phase 2A mirror) — confirmed it
  covers *runtime/presence* state (online/room/seat/inCall), not
  display/profile fields, so this step doesn't duplicate it.

## Exact scope of what's being migrated (documented, not implicit)

**In scope:** `name`, `photo`, `gender`, `country`, `language`,
`profile_completed`, `activeFrame`, `vipLevel`, `customTag`,
`nameEffect`, `customId` — enforced as an allowlist in code
(`PROFILE_FIELDS`), not just a comment; `setProfile()` throws on any
other key.

**Deliberately out of scope**, each with a reason (full detail in the
file header):
- `diamonds`/`coins` — owned by `module4/wallet/` (Step 4.4).
- Seats/room membership — owned by `module4/redis/roomState.js` (Step 4.3).
- `banned`/`verified`/`isHost` — access-control-relevant; a cache has
  a staleness window by definition, and serving a stale "not banned"
  is a security bug, not a performance tradeoff. Not offered by this
  module at all, so a future caller can't reach for them here by mistake.
- `passwordHash`/mobile — auth/PII, never belongs in a cache.
- `followersList`/`followingList`/`recentRooms`/`groups` — social
  graph/activity, a different entity, never in the Step 4.1 plan.
- `svipWealth`/`svipLevel`/`svipMembershipType` — wealth-adjacent;
  Step 4.1 scoped this step to non-financial fields explicitly.
- `agencyId`/`isCoinCenter` — admin/business role, not profile.
- `vehicleInventory`/`frameInventory` — ownership with its own expiry
  business logic; `activeFrame` (which one is shown) is in scope,
  the inventory backing it (what's owned) is not.

## What was built

`module4/redis/userProfile.js` — a write-through cache, not a second
source of truth: `setProfile(userId, patch)` is meant to be called by
whichever instance already updated its own local `users` object,
broadcasting the change; `getProfile(userId)` is a fast cross-instance
read. No lock is used (see file header "Why no lock") — each field is
independently meaningful, so Redis `HSET`'s per-field write can't
corrupt a concurrent write to a *different* field the way seat
assignment or balance arithmetic could.

## Verified (actually run this session)

- `node --check` passed.
- Ran the real no-Redis path: degraded to `false`/`null`, no throw.
- Ran against an in-memory mock Redis client (real `hset`/`hgetall`/
  `expire`/`del` logic, not just the no-op path):
  - Two separate partial writes to different fields for the same user
    both landed correctly — confirms `HSET`'s partial-write behavior
    is what this design depends on.
  - An out-of-scope field (`diamonds`) was correctly rejected with a
    clear error, proving the allowlist is enforced in code, not just
    documented.
  - Object-valued field (`activeFrame`) round-tripped correctly
    through JSON encode/decode.
  - Boolean field (`profile_completed`) round-tripped as an actual
    boolean, not the string `"true"`.
  - A user never written through returned `null` from `getProfile`
    (confirms the documented "cache, not a store" limitation behaves
    as described, not silently returning stale/wrong data).
  - `deleteProfile` correctly removed a cached entry.

## Known limitation (stated in the code and here, not glossed over)

This is a cache, not a queryable store. `getProfile()` for a user no
instance has ever written through returns `null` — there's no
Postgres fallback here (unlike wallet), because profile truth
deliberately stays as each instance's local `users` object per the
Step 4.1 plan's framing. At merge time, whatever calls `setProfile()`
needs to do so on connect/load, not only on edit, or reads from other
instances will show gaps. This wasn't glossed over in the design — see
file header, and see "Not Verified" below for what this means about
untested edge cases.

## Not Verified

- No real Redis instance was available this session — only the
  no-Redis path and the in-memory mock were exercised, same caveat as
  every prior Module 4 step.
- No integration with server.js — `setProfile()`/`getProfile()` have
  never been called from a real request/socket handler, so the
  "call on connect, not only on edit" merge-time requirement noted
  above is a design intention, not something this session verified
  gets followed correctly in practice.
- No test of TTL expiry actually firing (the mock's `expire()` is a
  no-op stub, matching the pattern used for `roomState.js`'s lock TTL
  testing in Step 4.3 — real expiry timing needs a real Redis instance).
- No multi-instance test of the actual scenario this step is meant to
  fix (instance A changes a user's `activeFrame`, instance B's seat
  render picks it up) — that requires the room-state integration from
  Step 4.3 plus a real two-process setup, neither of which exists yet.

## Failure/recovery considerations

- Redis absent/crashed: every function degrades to `false`/`null`,
  never throws — a caller integrating this should keep working off
  its local `users` object as it does today; this cache is purely
  additive speed/correctness for *other* instances, never a
  dependency for the instance that owns the write.
- Stale cache entry (TTL not yet expired, but data has changed and a
  write-through was somehow missed): self-heals after
  `MODULE4_PROFILE_TTL_SECONDS` (default 24h) even with zero explicit
  invalidation — deliberately generous since the primary correctness
  mechanism is explicit write-through, not TTL; TTL is only the
  safety net for a missed write-through, not the main mechanism.
- Account deleted: `deleteProfile()` exists for a caller to invoke
  explicitly; nothing in this module detects deletion on its own
  (that decision correctly stays in server.js, which is the only
  place that knows an account was deleted).

## Backward compatibility

- Zero risk to Module 3 or the current project: only requires other
  `module4/redis/*.js` files. No file under the original project was
  read-for-modification or changed.
- `users` in server.js, every profile-related route, and
  `redis/userState.js` are completely untouched.

## Diff summary — original project untouched

Re-confirmed this step: filesystem timestamp scan of every file under
the originally-extracted project, run immediately before packaging
this zip, returned zero files modified since extraction.

## Exact file list (new this step)

- `module4/redis/userProfile.js` (new)

Unchanged from prior steps (present in the zip): all of
`module4/redis/connectionFactory.js`, `keyspace.js`, `lock.js`,
`routing.js`, `roomState.js`; all of `module4/wallet/*`; all prior
`module4/docs/*.md`.

## Status: all four Step 4.1 entities now have their infrastructure layer built

routing (4.2) -> rooms (4.3) -> wallet (4.4) -> user profile (4.5).
None of them are wired into server.js yet — per your instruction, no
integration work has begun. Ready for the architecture review you
mentioned before any integration planning starts.
