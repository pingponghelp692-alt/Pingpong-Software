# Friendship/CP Seat-Adjacency Audit & Fix — Final Report
Project: `pingpong-FINAL/pingpong_final_work` — 2026-08-11

## 1. Root Cause

`getSeatRelationshipLinks()` in `friendshipCp.js` linked **every** pair of
currently-seated users who had an accepted relationship, with **no seat-position
check at all** — not even a naive `Math.abs(seatA - seatB) === 1`. It looped over
every seated pair and rendered a heart if a relationship existed, regardless of
where either user was sitting. That is the entire "far away heart" bug: two CP or
Friendship users anywhere in the room, adjacent or not, always got a heart.

The room's real seat layout (`public/style.css` `.seat-grid { grid-template-columns:
repeat(4, 1fr) }`, `server.js` `seats: Array(8)`) is a 4-column grid — seats 1-8 laid
out as:
```
1  2  3  4
5  6  7  8
```
A naive `Math.abs(a-b)===1` fix would have been wrong too: seat 4 and seat 5 satisfy
that check but are diagonally opposite corners, not neighbors — the row-wrap trap
the task instructions specifically warned about.

## 2. Fix — Seat Adjacency

New `seatAdjacency.js` module, single source of truth:
```js
areAdjacentSeats(seatA, seatB)
```
Computes each seat's `{row, col}` in the real 4-column grid and returns `true` only
for seats that share a grid **edge** — same row with columns 1 apart, or same
column with rows 1 apart. Diagonal neighbors and the seat-4/seat-5 row-wrap case are
correctly excluded. Grid width is configurable via `RELATIONSHIP_SEAT_GRID_COLUMNS`
(defaults to 4) so this stays correct if the seat count/layout changes.

Wired into `getSeatRelationshipLinks()` — the relationship itself (`state.relationships`)
still persists in the backend regardless of seating (per requirement #3), but the room
visual `relationshipLinks` array now only ever contains adjacency-gated pairs.

Verified the existing seat-change/leave/disconnect/mod-move-seat code paths already
called `emitToRoomRelationshipState()` on every relevant event — recalculation on
seat change was already wired, it just lacked the adjacency filter to recalculate
*correctly*. No changes were needed there.

Both server (only emits valid adjacent links) and client (`renderRelationshipLinks`
in `app.js`) now enforce adjacency — the client re-checks with its own
`clientAreAdjacentSeats()` port of the same grid logic as defense-in-depth, per
requirement #4, so a stale or malformed link can never render even if something
upstream regresses later.

## 3. Admin-Controllable Visual Settings

`friendshipCp.js` now persists a `relationship_visual_config.json` (width, height,
scale, opacity, animation on/off, animation speed, X/Y offset, custom-asset
enabled/path — per type, CP and Friendship) with a `version` counter that increments
on every save and doubles as the cache-bust token.

- `GET /api/relationships/config` — public, room client fetches this once per session.
- `GET/POST /api/admin/relationships/config/:type` (+ `/reset`) — admin read/write,
  gated by new `relationships:manage` permission (added to `rbac.js`'s `PERMISSIONS`
  and `SECTION_PERMISSIONS`).
- `POST /api/admin/relationships/asset/:type` — PNG upload (new multer instance
  mirroring the existing `frames` upload pattern: PNG-only, 5MB cap, path-traversal-safe
  filenames), `/restore-default` to revert.
- Every save/upload broadcasts `relationship-config-update` over Socket.IO so
  already-connected clients update live — no refresh needed.
- CSS variables (`--cp-width`, `--cp-height`, `--cp-opacity`, `--cp-anim-duration`,
  matching `--friendship-*`) are the only source `style.css` reads for size/opacity/
  animation speed now; the old hardcoded `.relationship-link.cp{width:126px...}` is
  gone. Offset X/Y is applied directly to the computed pixel position in `app.js`
  (not via CSS transform) and per-element `--rel-scale` is used so the float
  keyframe animation can multiply in the right scale without fighting the offset —
  a real bug I caught and fixed while building this (a shared keyframe with a fixed
  `translate(-50%,-50%)` would have silently overridden any admin-set offset/scale
  during the animation loop).
- New "Relationship Settings" section in the Admin Panel (`admin/index.html` +
  `admin/app.js`) with CP and Friendship panels: enable-custom-asset checkbox,
  upload/preview/restore-default, width/height/scale/opacity fields, animation
  on/off + speed, X/Y offset, Save + Reset to Default.

## 4. Testing

New `test/seatAdjacency.test.js` (22/22 passing) — every example from the task spec,
the seat-4/seat-5 row-wrap case, vertical neighbors, diagonals, symmetry, and
malformed-input edge cases (never throws).

New `test/friendshipCpVisual.test.js` (32/32 passing) — exercises the real
`friendshipCp.js` module end-to-end against a lightweight mock of its server.js
dependencies (this project's established pattern for modules that can't be
`require()`'d against a live Express/Socket.IO server in this sandbox — same
limitation documented in every prior session). Covers, directly against the task's
numbered test list:

- **TEST 1/2** — CP adjacent → link present; non-adjacent → no link
- **TEST 3/4** — move to non-adjacent → link disappears; move back → reappears
- **TEST 5/6** — same for Friendship, independently from CP
- **TEST 7** — user leaves seat → link disappears
- **TEST 9** — admin resizes CP 126px→60px, change reflected + live broadcast fires
- **TEST 10** — setting survives a simulated server restart (re-read from disk)
- **TEST 11** — PNG upload changes the cache-bust version/URL immediately
- **TEST 13** — existing request/accept flow (duplicate-request rejection) still works
- Row-wrap corner case (seat 4/5) via the real `getSeatRelationshipLinks` path
- Reset preserves the custom-asset-enabled flag (spec: reset is size/position only)
- Input clamping (width/opacity/scale can't be pushed to nonsense values)

Full existing suite: **26/26 suites, all green**, including the two new ones (test
runner auto-discovers `test/*.test.js`). Full-repo syntax sweep: **154/154 `.js`
files clean** (`node --check`). `admin/index.html`'s `<section>`/`</section>` tags
balanced (31/31).

**TEST 8** (disconnect/reconnect → no stale heart) is covered by the existing,
already-verified `handleUserLeaveRoom()` → `emitToRoomRelationshipState()` wiring
(confirmed present, unchanged) combined with the adjacency fix — not separately
re-tested here since it exercises the same code path as TEST 7.
**TEST 12** (Friendship size change) is the same code path as TEST 9, parameterized
by type — covered by the `friendshipCpVisual.test.js` suite treating `cp`/`friendship`
symmetrically throughout.

## 5. Honest Limitations

- **Sandbox has no network egress** (documented in every prior session on this
  project) — `node_modules` isn't installed, so `server.js` cannot actually be
  booted here, and there's no way to load-test a real browser rendering the CP/
  Friendship hearts or click through the new Admin Panel section live. All testing
  above is static (syntax) + module-level (mocked dependencies), same rigor as
  every previous audit round on this project.
- I did **not** independently re-verify unrelated, previously-audited subsystems
  (voice/SFU, wallet, gifts, etc.) — this pass touched only `friendshipCp.js`,
  `seatAdjacency.js` (new), `server.js` (additive folder/multer/route wiring +
  the `initFriendshipCp()` call), `rbac.js` (one new permission), `public/app.js`,
  `public/style.css`, and `admin/index.html`/`admin/app.js`. No other file was
  modified.
- Vertical adjacency (seat 1↔seat 5, directly below) is treated as adjacent, same
  as horizontal — the task's explicit examples only covered horizontal cases, but
  a plain edge-adjacency rule (not diagonal) is the natural reading of "physically
  neighboring" for a 2D grid and is documented clearly in `seatAdjacency.js` in case
  you want it restricted to same-row-only instead — that's a one-line change if so.

## 6. Files Changed / Added

- **New:** `seatAdjacency.js`, `test/seatAdjacency.test.js`, `test/friendshipCpVisual.test.js`
- **Modified:** `friendshipCp.js` (adjacency filter + visual config + admin routes),
  `server.js` (folder/static/multer wiring, `initFriendshipCp()` call), `rbac.js`
  (`relationships:manage` permission + section), `public/app.js` (config fetch/apply,
  defensive client-side adjacency check, cache-busted asset URLs), `public/style.css`
  (CSS-variable-driven CP/Friendship sizing), `admin/index.html` + `admin/app.js`
  (new Relationship Settings section)
