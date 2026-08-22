# Phase 1 Audit: Room 101 + Robin AI + Vapi Voice Support
Date: 2026-08-12
Scope: This is a **prioritized first phase** of the full audit requested — Room 101,
the AI provider chain, and Robin/Vapi wiring only. Admin panel deep-dive, full API
inventory, Socket.IO inventory, and the 30-step live smoke test are follow-up phases
(the live smoke test specifically requires running on a real device — this
environment has no network egress, so `npm install` / a live server / a real
Gemini/OpenAI/Vapi/LiveKit call could not be executed here).

## Method
Every claim below is from actually reading the code end-to-end (not filename-based
assumptions), tracing: browser → `public/vapi-support.js` / `app.js` → `server.js`
routes & socket handlers → `ai/` modules → `ai/providers/*` → `data/cs101_config.json`.
Where a fix was made, it was syntax-checked (`node --check`) and, where testable
without network, covered by a new automated test that was actually run.

## VERIFIED (already correct, no change needed)
- **Vapi credential handling**: `public/vapi-support.js` never embeds a key; it calls
  `GET /api/vapi/config`, which returns only `VAPI_PUBLIC_KEY`/`VAPI_ASSISTANT_ID`
  (server.js:5132). No private Vapi key exists anywhere in the codebase.
- **AI provider chain**: `cs101:message` → `cs101GenerateReply()` → `generateAIReply`
  (`ai/ai-service.js`) → `ai/providers/gemini-provider.js` or `openai-provider.js` →
  raw HTTP call → normalized `{text, usage}`. Server-side only; no API key ever
  reaches the frontend.
- **Graceful failure**: both providers throw plain `Error` objects with no secret in
  the message; `ai-chat.js`/`ai-room-assistant.js` already catch and show a generic
  "cannot respond right now" message to the customer — no stack trace/API key leak.
- **Avatar/room-image upload chain** (`/api/admin/cs101/avatar`, `/room-image`):
  gated by `requireAdmin` + `requirePermission("ai-core:manage")` (permission is
  really registered in `rbac.js:113`, not a phantom string) → `multer` with MIME
  filter + size cap + `safeFilename()` (path-traversal-safe) → unique
  `Date.now()-filename` per upload (this **is** the cache-busting mechanism — a new
  upload always gets a new URL, so stale-browser-cache isn't actually possible here)
  → `cs101Config` written to `data/cs101_config.json` → `io.to(CS101_ROOM_ID).emit(...)`
  pushes the update live to anyone already in Room 101.
- **Restart persistence**: `cs101Config` is loaded from `data/cs101_config.json` at
  boot (server.js:2453) and every admin change calls `saveCs101Config()` — confirmed
  by reading the file, which already reflects a real prior save (agent name "Robin").
- **Room 101 protected from deletion**: `DELETE /api/admin/rooms/:roomId` explicitly
  blocks `roomId === "101"` (server.js:5161-5163).
- **Human customer-service admin**: the existing RBAC already supports this — create
  a Moderator account with `assignedRoomIds: ["101"]` and their room actions are
  scoped to Room 101 only (`rbac.js` `inRoomScope`). No new/conflicting permission
  system was needed or built. (Note: this wasn't labeled anywhere as "the way to add
  a Room 101 human admin" — that's a documentation gap, tracked below, not a code bug.)

## FIXED THIS PHASE
1. **No cross-provider fallback existed** (your requirement #4 explicitly asks for
   this). Previously: if Gemini failed, the customer got the generic "cannot respond"
   message even if a valid `OPENAI_API_KEY` was configured — the two providers were
   fully independent, `AI_PROVIDER` picked exactly one with no escape hatch beyond
   2 same-provider retries.
   **Fix**: `ai/ai-service.js` now tries `AI_FALLBACK_PROVIDER` (new env var) if the
   primary provider fails and the fallback provider has its own API key configured.
   Falls back to the old behavior exactly (throws immediately) if
   `AI_FALLBACK_PROVIDER` is unset — nothing changes for you unless you opt in.
   Covered by 7 new tests in `test/aiProviderFallback.test.js`, all passing.
2. **`.env.example` never listed `AI_PROVIDER`/`GEMINI_API_KEY`/`OPENAI_API_KEY`/
   `AI_FALLBACK_PROVIDER` at all** — anyone deploying from that file alone would have
   no AI replies and no clue why. Added with comments.

## EXTERNAL CREDENTIAL REQUIRED (not testable locally, needs your real key)
- `GEMINI_API_KEY` and/or `OPENAI_API_KEY` — without at least one, Room 101 text
  replies will always show the fallback "cannot respond right now" message. Neither
  key was present anywhere in the ZIP.
- Real Vapi Assistant must exist and be **published** under the same Vapi project as
  the public key, or `startCall()` in `vapi-support.js` will surface a clear
  "Vapi rejected the Public Key" / "Assistant not found" status message (already
  handled — see its `catch` block) rather than failing silently.

## NOT TESTABLE LOCALLY (needs your device / real network)
- Actually placing a Gemini/OpenAI call, an actual Vapi voice call, actual LiveKit
  connection — this sandbox has no network egress and no `node_modules` installed
  (`npm install` also requires network). These must be run on your Termux device.

## MINOR / LOW-PRIORITY (not fixed yet — flagging honestly rather than skipping)
- `uploadPhoto`/`uploadBg` (avatar/room-image) validate `file.mimetype`, which is
  client-supplied and technically spoofable. Files are served statically (never
  executed by Node), so this is low real-world risk, not a critical gap — but true
  magic-byte/extension validation would be stronger. Can add in a later phase if
  you want it.
- The "human Room 101 admin" mechanism (RBAC `assignedRoomIds`) isn't surfaced
  anywhere in the Admin Panel UI as "assign a Room 101 support admin" — it works,
  but an admin creating one has to already know to set `assignedRoomIds: ["101"]`
  on a Moderator account. A UI label/shortcut could be added in the Admin Panel
  phase if useful.

## Files changed this phase
- `ai/ai-config.js` — added `AI_FALLBACK_PROVIDER`
- `ai/ai-service.js` — added cross-provider fallback logic
- `.env.example` — documented all AI-related env vars (previously undocumented)
- `test/aiProviderFallback.test.js` — new, 7 assertions, all passing
- `PHASE1_ROOM101_ROBIN_VAPI_FINDINGS_2026-08-12.md` — this file

## Regression check
Ran the full existing suite (`node test/run-all.js`): **27/27 suites passed**,
including the new one, with no changes to any other file.
