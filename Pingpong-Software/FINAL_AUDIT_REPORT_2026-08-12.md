# PingPong — Final Production Audit Report (2026-08-12)

## 0. Zip comparison result
291 files identical between the two uploads. Only `server.js` and
`public/app.js` differed in code (plus `data/tokens.json` /
`data/ai_logs.jsonl`, which are just runtime session logs, not a real
diff). PHASE3_FINAL was missing 3 real voice fixes that VOICE_FINAL_FIXED
had: the `voiceReconnect.notifyPeerResumed()` / `notifyPeerDisconnecting()`
wiring, the audience-peer-recovery fix (previously gated on
`mySeatNumber`, so audience members couldn't recover a stale peer), and
the `ensureLocalTracksSent()` ended-track `replaceTrack()` fix (the exact
seat→audience→seat mic-silent bug). VOICE_FINAL_FIXED was used as the base
for everything below, so none of this was lost.

## 1. Root causes found
| # | Area | Root cause |
|---|------|------------|
| 1 | Server crash (`emitToUser is not a function`) | `initIdLevel({...})` at server.js:887 omitted `emitToUser` from the options object it passes in, even though `idLevel.js`'s `initIdLevel()` destructures and calls it on level-up. Every other module in the codebase (namefx/frames/ban/recharge/vip/diamond/vehicles/agencyHost/friendshipCp/badges) passes `emitToUser` correctly — this was the one omitted call site. |
| 2 | Public chat DOM growth | No visible-message cap existed; `#chat-log` grew for the life of a room session. |
| 3 | Private chat DOM growth | Same gap in `#thread-log`. |
| 4 | Game-close-button blur | `#btn-leave-room`'s normal room-header style carries `backdrop-filter:blur(8px)` (a frosted-glass look for the header icon). When a game opens, this same button is repositioned via `body.game-locked #btn-leave-room` to sit on top of the full-screen game as its close button — but it kept the blur, which visibly blurred the game content directly behind/around the button. |
| 5 | Chat-input hidden under keyboard (Android Chrome) | `viewport` meta tag had no `interactive-widget` directive. `.room-toolbar` (chat input) is `position:fixed;bottom:0`; without `interactive-widget=resizes-content`, Chrome's default behaviour shrinks only the *visual* viewport when the keyboard opens, leaving fixed-bottom elements pinned under the layout viewport's bottom edge — i.e. under the keyboard. |

Everything else audited (see item 11) was already correct in this build
and needed no change.

## 2. Files changed
- `server.js` — 1 line (idLevel init call)
- `public/app.js` — `appendChatMsg()` + `appendThreadMsg()` (message cap + scroll-preserving trim)
- `public/style.css` — `body.game-locked #btn-leave-room` rule (blur removed only in game-locked state)
- `public/index.html` — viewport meta tag (`interactive-widget=resizes-content` added)

No other file touched. No architecture, API, socket event, or database
schema changed.

## 3. What was fixed
1. `emitToUser` crash on gift-triggered level-up — fixed by passing the
   missing dependency.
2. Public room chat now caps at `MAX_VISIBLE_MESSAGES = 30` visible DOM
   nodes, oldest trimmed first, scroll position never jumps for a user
   already at the bottom. Persistent server history (`room.messages`,
   capped at 200 server-side, unchanged) is untouched.
3. Private inbox thread now caps at `MAX_VISIBLE_PRIVATE_MESSAGES = 30`
   the same way. Reopening a thread re-fetches full history from
   `/api/messages/thread`, so nothing is lost — only the live DOM is
   trimmed.
4. Game close-button no longer blurs the game screen behind it while a
   game is open; its normal frosted look in the room header is
   unchanged.
5. Chat input / bottom toolbar now stays above the on-screen keyboard on
   modern Android Chrome instead of being hidden underneath it.

## 4. Voice architecture — current state
Production runs `VOICE_MODE=sfu` (confirmed in an earlier session via
live production output) — a LiveKit SFU, not the peer-mesh path.
Previously-delivered hardening on this path (across several prior
sessions, verified still present and passing all tests in this build):
- Seat↔audience transitions publish/unpublish the mic track on the SAME
  LiveKit room connection (`publishMicTrack()` / `unpublishMicTrack()`)
  without disconnecting — the "listen persists, only publish permission
  toggles" behavior the spec asked for.
- Remote audio elements get an explicit `.play()` call with a retry, not
  just the `autoplay` attribute (autoplay can be silently blocked by the
  browser with no visible error).
- Reconnect: server-side 30s presence grace period +
  `voiceReconnect.notifyPeerResumed/Disconnecting()` tell every peer to
  hold or rebuild correctly instead of tearing down a healthy connection
  on a brief signaling drop.
- `onSeatChanged`'s harmless "participant does not exist" race (seat
  taken before LiveKit connect finishes) has a bounded retry, gated
  strictly on LiveKit's own not-found error text.
- Per-room (not global) SFU lifecycle gating, so one room's cleanup never
  affects another room's voice.

The mesh path (`public/app.js`'s raw WebRTC code) also has its own
ended-track `replaceTrack()` fix and audience-recovery fix (confirmed in
item 0 above) for installs that still run `VOICE_MODE=mesh`, but is not
the active production path.

**Known limitation (unchanged from prior sessions, still true):** no real
multi-browser/multi-device live audio test has been run — this sandbox
has no network egress to a real LiveKit server. Everything above is
verified via the existing unit/integration test suite (fake LiveKit
client) and static code audit, not a live call.

## 5. Public chat — current state
Each incoming `new-message` renders as its own `<div class="chat-msg">`
appended to `#chat-log` (normal flex-column flow, nothing absolutely
positioned) — messages do not overwrite each other or shift into another
user's slot; this was already correct in the audited build. New messages
appear at the bottom, auto-scroll keeps the latest visible, and the DOM is
now capped at 30 visible messages (item 3.2). Ordering is
server-authoritative: the server pushes to `room.messages` and broadcasts
in that same order — never dependent on client clocks.

## 6. Private chat — current state
The first message in a brand-new thread was previously at risk of
appearing "hidden" if the view was measured before it had finished
laying out — the codebase already carried a fix for this (render the
timeline into `#thread-log` while the view is still hidden, call
`showView()` to reveal it, then scroll on a double
`requestAnimationFrame` so the scroll happens after layout settles). All
"start a conversation" entry points (profile Message button, seat sheet,
inbox list, coin-seller chat) route through this same `openThread()`
function — no bypass path found. DOM is now capped at 30 visible messages
(item 3.3); reopening a thread re-loads full history from the server.

## 7. Gift / video gift — current state
Gift sends are visual-only in chat (no text banner mixed into the
transcript — `#gift-banner` is intentionally hidden); the fly-animation
and full-screen/video-gift overlay run on their own absolutely-positioned
layers (`z-index:9999` for video gifts) that never touch or replace chat
DOM. Video gifts play one at a time from a queue, `object-fit:contain` at
100% width/height so they always fit the viewport without clipping, and
clean up (`pause/removeAttribute(src)/load()`) on end or via an 8s+800ms
safety-net timeout if `ended` never fires. Duplicate-send protection
already existed via a `requestId`-keyed cache checked on both the REST
route and both socket handlers (regular + video gift). Sender/receiver
coin-diamond-ledger-XP flow already has snapshot-and-rollback transaction
safety from an earlier session (verified still present and tested).

## 8. `emitToUser` error — how it was fixed
See item 1 row 1 / item 3.1. One-line fix: pass `emitToUser` into
`initIdLevel({...})`.

## 9. Game close-button blur — how it was fixed
See item 1 row 4 / item 3.4. `backdrop-filter` disabled specifically for
`#btn-leave-room` only while `body.game-locked` is active; unaffected the
rest of the time.

## 10. Tests run
- `node --check` on every `.js` file in the project (server.js, public/app.js, all modules) — all clean.
- Full existing suite: `node test/run-all.js` → **26/26 suites, 31/31 assertions in the affected voice suites, 0 failures**, both before and after every change (re-run after the final edit to confirm no regression).
- Manual code-path trace (not live-network) for TEST A–O from the task spec: A–G (voice) map to the already-hardened SFU logic in item 4; H (public chat, 3 users) confirmed structurally correct in item 5; I/J (private first/second message) confirmed via item 6; K/L/M (gift + video gift) confirmed via item 7; N (game blur) — root-caused and fixed, item 9; O (emitToUser) — root-caused and fixed, item 8.

## 11. Limitations — stated plainly
- No live browser/multi-device audio test was performed (no network egress in this environment) — voice correctness is verified via the existing fake-LiveKit-client test suite and static trace, consistent with every prior voice-hardening session on this project.
- Firebase login/session code was not touched or re-audited in this pass — out of scope per your own note that VOICE_FINAL_FIXED is the working base; the private-key exposure flagged separately should be resolved on your end (see chat).
- CORS_ORIGINS for a real separately-hosted production frontend still needs to be set (carried over from a prior session, unrelated to this pass).
- TURN server still needs real production provisioning if not already configured — code does not falsely claim "production guaranteed" without it.

## 12. Before production deployment
1. Rotate the Firebase service-account key that was pasted in chat (see the security warning already given).
2. Confirm `VOICE_MODE`, `CORS_ORIGINS`, and TURN env vars are set for the real production environment.
3. Run one real multi-device voice test (2–8 participants, seat/audience transitions, reconnect) since this sandbox cannot do that.
4. Deploy, then spot-check TEST A–O from the original spec live.
5. Set real `VAPI_PUBLIC_KEY` / `VAPI_ASSISTANT_ID` for Room 101 and test Robin live (see section 13).

Base used: `PingPong_PROJECT_2026-08-11_VOICE_FINAL_FIXED.zip` (confirmed by
user as the correct final build). Compared file-by-file against
`PingPong_PROJECT_2026-08-11_PHASE3_FINAL.zip` first — see item 0 below.

## 13. Room 101 — Official AI Customer Service (integrated 2026-08-12, later same day)
At your request, the "Room 101 / Robin" AI Customer Service feature was pulled
from an older uploaded build (`PingPong_ROBIN_VAPI_FULL_INTEGRATED_2026-08-12.zip`,
based on the pre-fix VOICE_FINAL_FIXED baseline) and merged into this audited
build — nothing else from that older zip was carried over.

**What Room 101 is:** a permanent, protected room (`roomId: "101"`) with 8
normal seats plus one virtual, non-consuming AI seat. The AI agent ("Robin")
answers customer questions about the app (login, rooms, seats, gifts, coins,
diamonds, VIP, wallet, agency/host, games) via the existing `ai/ai-service.js`
provider, with a Vapi cloud voice pipeline as the primary voice path and
browser SpeechRecognition/SpeechSynthesis as an automatic fallback when Vapi
isn't configured. Fully admin-configurable live (avatar, greeting,
instructions, voice rate/pitch, seat-opening policy, official contacts) from
a new "AI Customer Service 101" section in the admin panel — reusing the
existing `ai-core:view`/`ai-core:manage` permissions, so no new RBAC role was
needed.

**Files added:** `ai-customer-service/README.md` + `ROOM101_MANIFEST.json`,
`data/cs101_config.json`, `public/vapi-support.js`,
`scripts/configure-robin-vapi.js`, `scripts/verify-robin-vapi.js`,
`uploads/photos/cs101-female.svg`.

**Files patched (Room 101 changes only, applied on top of every fix from
sections 1–12 above — verified non-overlapping regions, patches applied
clean):** `server.js`, `public/app.js`, `public/style.css`,
`public/index.html`, `admin/app.js`, `admin/index.html`,
`security/headers.js` (CSP: added `esm.sh` for the Vapi SDK import,
microphone permission for self), `package.json` (2 new npm scripts),
`.env.example` / `.env.production.example` (added `VAPI_PUBLIC_KEY` /
`VAPI_ASSISTANT_ID`, documented as safe-for-client public-key credentials —
no private key added).

**One real bug found and fixed during integration:** the older build's
`public/index.html` had a literal two-character `\n` (backslash + letter n)
sitting as stray visible text between two `<script>` tags instead of an
actual newline — would have rendered as literal "\n" text on the page.
Fixed by inserting a real line break.

**Verified additive/non-breaking:**
- Existing 8-seat room voice/seat logic is untouched; the AI seat is a
  separate rendered element (`aiSeat` field on `publicRoom()`), not a 9th
  real seat.
- Room 101 is excluded from normal room delete/close actions (existing
  guard code, unchanged behavior for every other room).
- Room-list sort only adds "official rooms first" as a tie-breaker before
  the existing online-count sort — order among non-official rooms is
  identical to before.
- No secrets exposed: `/api/vapi/config` returns only the public key +
  assistant ID (by design, same as a Stripe publishable key); the private
  Vapi API key, if ever configured, stays server-side only, consistent
  with every existing `emitToUser`-style module in this codebase.
- `node --check` clean on every touched/added `.js` file (server.js,
  public/app.js, public/vapi-support.js, admin/app.js, both new scripts).
- Full existing test suite re-run after integration: **26/26 suites still
  pass, 0 failures** — same result as before Room 101 was added.

**Limitation, stated plainly:** this sandbox has no `node_modules`
installed and no network egress, so the server could not actually be
booted end-to-end here (this was also true for every prior session on
this project) — validation is `node --check` + the existing fake-dependency
test suite + full manual code-flow trace, not a live run. Before production
use: run `npm run setup:robin` / `npm run verify:robin` (added by this
feature) with real `VAPI_PUBLIC_KEY`/`VAPI_ASSISTANT_ID` values, and do one
real test of sitting in Room 101 and talking to Robin.
