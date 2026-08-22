# Production Fix Report — Room 101 / Ritu Voice — 2026-08-13

## Scope and honesty note

This ZIP had already been through at least 3 prior AI-assisted fix sessions
(`ROOT_CAUSE_FIX_2026-08-03.md`, `VOICE_FINAL_FIX_2026-08-11.md`,
`ROOM101_AUTO_VOICE_ADMIN_CHAT_FIX_2026-08-12.md`,
`FINAL_AUDIT_REPORT_2026-08-12.md`), each claiming these same requirements
were satisfied. This session's sandbox has **no network access and no
`node_modules` installed** — same limitation every prior report already
disclosed. So, same as before:

- **Statically verified**: `node --check` passed on every file touched below.
  Logic was traced by reading, not by running.
- **NOT locally tested**: the server was never actually started; no request
  was ever actually sent; no browser/microphone was involved.
- **Requires real testing**: every item below, especially the two seat-lifecycle
  fixes, needs one real pass of sitting in Room 101 with a real device before
  you trust it in production.

Given the project's size (7,400+ line server.js, Android app, admin panel,
Redis clustering layer, LiveKit SFU), a full re-audit of all 15 requested
steps was not attempted from scratch. Instead, each requirement was checked
against what's actually in the code; most were already correctly implemented
by the prior session, and are noted as "verified, no change needed" below.
Two real, previously-unfixed bugs were found and fixed.

## API keys / credentials — unchanged, confirmed safe

No `.env` value was touched. Confirmed by reading (not assuming):
- `/api/vapi/config` returns only `VAPI_PUBLIC_KEY` + `VAPI_ASSISTANT_ID` —
  the same class of credential as a Stripe *publishable* key, safe for the
  browser by Vapi's own architecture.
- `LIVEKIT_API_KEY/SECRET`, `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64`
  are read only server-side (`server.js`, `voice_sfu/`, `ai/`) — grepped for
  any reference to these names inside `public/*.js` and found none.

## Fixed this session

### 3. Ritu did not reliably speak first — `public/vapi-support.js`
Whether Ritu greets the customer immediately or waits for them to speak
first was previously controlled entirely by the assistant's "first message
mode" setting on the Vapi **dashboard**, outside this codebase — so the app
had no guarantee of it. Added `firstMessageMode: "assistant-speaks-first"`
to the `vapi.start()` call override. This is a standard, documented Vapi
field (not a custom tool schema), so it can't make `start()` reject the way
an unsupported override previously could (see the existing code comment
about why a client-side tool definition was deliberately avoided). Now
Ritu greets the customer the instant the call connects, regardless of the
dashboard setting.

### 4. Chat messages had no entrance motion — `public/style.css`
Added a plain CSS animation (`chatMsgRiseIn`) applied to `.chat-msg` on
append: each message fades and slides up ~14px into place independently,
so consecutive messages — even from the same user — each visibly "rise"
into the chat box on their own rather than just appearing instantly.
Respects `prefers-reduced-motion`. Pure CSS, no JS/layout change, so it
can't affect scrolling or the dedup fix from the previous round.

### Spot-checked, not changed
- `voice_sfu/sync.js` `onSeatChanged()`: uses LiveKit's participant
  **update** call (metadata + permission), not a create — updating the same
  participant's state repeatedly is naturally idempotent, and the `safe()`
  wrapper already distinguishes the expected "seat changed before LiveKit
  connect() landed" race from a real failure. Looked structurally sound on
  reading; not exercised against a live LiveKit server.

### 1. Ritu (Vapi) orphan-call race — `public/vapi-support.js`
**Real bug, previously unfixed.** If a user left the Customer Service seat
while `startCall()` was still connecting (loading config/SDK, or waiting on
Vapi's `start()` network round-trip), `endCall()` had no established call to
stop yet and silently no-op'd. The in-flight `start()` would then resolve
*after* the seat was already vacated, opening Ritu's microphone for a call
tied to a seat nobody was sitting in anymore.

Fix: added a `state.stopRequested` flag. `endCall()` sets it (and resets the
UI immediately) if called while a start is in progress. The moment
`startCall()`'s `vapi.start()` actually resolves, it checks the flag and, if
set, immediately calls `vapi.stop()` and tears the call back down instead of
leaving it active. Covers: rapid seat leave during connect, room change
during connect, and reconnect-during-connect.

### 2. Chat duplicate-message rendering — `public/app.js`
**Real bug, previously unfixed** (the server-side half of this fix — a unique
`msg.id` from `crypto.randomUUID()` — was already added in the 2026-08-12
session, but the client never used it). `socket.on("new-message", ...)`
appended blindly with no dedup, so any duplicate delivery (socket resend on
reconnect, a retried cross-instance forwarded op) would render the same
message twice.

Fix: added `renderedChatMsgIds` (a `Set` of currently-rendered message ids).
`appendChatMsg()` now skips rendering if the id was already rendered, and the
id is cleaned up from the set when that message's DOM node is later removed
(TTL expiry or the 30-message cap), so the set can't grow unbounded.

## Verified already correct — no change made

- **Firebase concurrent-login dedup** (`server.js`, `withFirebaseLoginLock`):
  an in-process keyed mutex around the check→create→save sequence, added
  2026-08-12. Correctly serializes concurrent requests for the same UID
  within one running Node process. Documented limitation (already present in
  the code comment): `users` is this process's own in-memory object, not a
  shared store — if this is ever scaled to multiple Node processes/containers,
  this lock cannot serialize across them and the user store would need to
  move to a real shared backend (Postgres/Redis, already present in
  `docker-compose.production.yml`) with an atomic upsert. Worth confirming
  with whoever runs deployment: is this a single Node process today?
- **Room 101 default two open seats** (`server.js`, `data/cs101_config.json`):
  `openSeatCount: 2` is persisted, with a one-time `_seatCountMigratedV2`
  migration flag so an installation stuck at the old default of 1 gets
  bumped once, but an admin's deliberate choice of 1 (before or after the
  migration) is never silently overwritten again.
- **Chat message isolation** (`public/app.js`, `appendChatMsg`): each message
  already renders as its own `<div class="chat-msg">` — no merging of
  consecutive same-user messages into one bubble.
- **Vapi credential exposure**: see above.

## Not re-verified this session (unchanged from prior reports, not re-audited)

- LiveKit/SFU seat-event idempotency (`voice_sfu/`)
- AI room-admin authorization/action layer (`server.js` `cs101:admin-command`
  handler, `ai/ai-room-assistant.js`)
- Socket/session/reconnect identity consistency beyond the Firebase lock
- Cache-busting/versioning for `app.js`/`vapi-support.js`
- Silent-failure/error-handling audit across all listed subsystems
- Android app changes

These were not touched or re-checked in this session — treat prior reports'
claims about them as unverified until someone does a real run-through, not
as confirmed by this report.

## Recommended next step

This class of bug (a lifecycle race that only shows up under real timing) is
much easier to actually catch with a live server, real browser, and a real
microphone than by reading code in a sandbox with no network. If these two
fixes don't fully resolve what you're seeing in production, the next move
should be running this with `npm install` + `npm start` in an environment
with real execution (e.g., Claude Code, or your own machine) so the
acceptance tests (TEST A–N in your spec) can actually be run, not just
reasoned about.
