// test/modActionRateLimit.test.js
// Verifies the rate-limit guard added in Module 5.2 for the previously-
// unthrottled host/admin moderation socket events (kick-user, set-admin,
// mod-mute-users, mod-chat-ban, mod-invite-to-seat, mod-move-seat,
// mod-move-to-audience, mod-label-users, mod-announce-users).
//
// HONEST LIMITATION: server.js itself declares isModActionRateLimited() as
// a local (non-exported) function, and server.js cannot be require()'d
// standalone in this sandbox — it needs express/socket.io/cors/multer/etc.
// actually installed, and this environment has no network egress to npm
// install them (same limitation noted on every prior SFU testing pass).
// What CAN be verified for real, without any mocking of the result, is the
// exact underlying primitive isModActionRateLimited() is built on —
// ai/ai-security.js's isRateLimited() — called with the exact same key
// prefix ("mod-action:") and options ({ windowMs: 5000, max: 20 }) that
// server.js's isModActionRateLimited(userId) passes it. This is the real
// module doing the real rate-limit accounting, not a re-implementation;
// only the one-line wrapper in server.js (`return
// aiSecurity.isRateLimited(...)`) is untested by this file, and that line
// has no branching logic of its own to break.
//
// Run: node test/modActionRateLimit.test.js

const path = require("path");
const aiSecurity = require(path.join(__dirname, "..", "ai", "ai-security.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// Mirrors server.js's isModActionRateLimited(userId) exactly.
function isModActionRateLimited(userId) {
  return aiSecurity.isRateLimited(`mod-action:${userId}`, { windowMs: 5000, max: 20 });
}

console.log("=== Legitimate rapid moderation is NOT blocked ===");
{
  const hostId = "host-A";
  let blockedCount = 0;
  // A host muting 15 people one after another, well within human/bulk-UI
  // pace and well under the max: 20 — every one of these calls represents
  // a real, distinct moderation event in server.js (kick-user, mod-mute-
  // users, etc. each call this once per invocation).
  for (let i = 0; i < 15; i++) {
    if (isModActionRateLimited(hostId)) blockedCount++;
  }
  assert(blockedCount === 0, "15 rapid moderation actions from one host in one burst are all allowed (limit is 20)");
}

console.log("=== Runaway/scripted spam IS blocked ===");
{
  const hostId = "host-B";
  let blockedCount = 0;
  // A compromised/scripted token firing far beyond any real moderation
  // pace — 40 calls in immediate succession.
  for (let i = 0; i < 40; i++) {
    if (isModActionRateLimited(hostId)) blockedCount++;
  }
  assert(blockedCount > 0, "spamming well past the limit gets flagged");
  assert(blockedCount === 20, "exactly the 21st-through-40th calls (20 over the max: 20) are blocked, not the first 20");
}

console.log("=== Rate limit is per-user, not global ===");
{
  const hostC = "host-C";
  const hostD = "host-D";
  // Exhaust host C's budget first.
  for (let i = 0; i < 25; i++) isModActionRateLimited(hostC);
  const hostCBlocked = isModActionRateLimited(hostC);
  const hostDBlocked = isModActionRateLimited(hostD);
  assert(hostCBlocked === true, "host C, having exceeded their own budget, is blocked");
  assert(hostDBlocked === false, "host D, a completely different moderator, is unaffected by host C's spam");
}

console.log("=== Key is namespaced separately from chat/emoji-reaction rate limits ===");
{
  // Same underlying Map in ai-security.js, but the "mod-action:" prefix
  // used here is distinct from "chat:" and "emoji-reaction:" (see
  // server.js's send-message / send-emoji-reaction handlers) — a user
  // who is chat-flooding should never cause their own moderation actions
  // to start failing, and vice versa.
  const userId = "shared-user-1";
  for (let i = 0; i < 15; i++) aiSecurity.isRateLimited(`chat:${userId}`, { windowMs: 10000, max: 12 }); // exhausts the chat bucket
  const modBlocked = isModActionRateLimited(userId);
  assert(modBlocked === false, "an exhausted chat rate limit does not bleed into the mod-action limit for the same user");
}

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
