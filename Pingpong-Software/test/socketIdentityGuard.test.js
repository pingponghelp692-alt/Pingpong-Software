// test/socketIdentityGuard.test.js
// Phase 1 (Firebase/Identity Audit, 2026-08-10) — AUTH-1 regression test.
// Verifies security/socketIdentity.js, the guard now wired into
// server.js's "join-room" socket handler to stop an already-verified
// socket from claiming a different userId than the one its "identify"
// event proved ownership of.
//
// Run: node test/socketIdentityGuard.test.js

const path = require("path");
const socketIdentity = require(path.join(__dirname, "..", "security", "socketIdentity.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("=== isJoinIdentityAllowed: unverified socket (legacy client, no prior identify) ===");
{
  assert(socketIdentity.isJoinIdentityAllowed(null, "user_123") === true,
    "join-room as any userId is still allowed when the socket never verified an identity (no regression for legacy clients)");
  assert(socketIdentity.isJoinIdentityAllowed(undefined, "user_123") === true,
    "same, with undefined authedUserId");
}

console.log("=== isJoinIdentityAllowed: verified socket joining as ITSELF ===");
{
  assert(socketIdentity.isJoinIdentityAllowed("user_123", "user_123") === true,
    "a socket verified as user_123 can join-room as user_123");
}

console.log("=== isJoinIdentityAllowed: verified socket trying to claim a DIFFERENT userId (impersonation) ===");
{
  assert(socketIdentity.isJoinIdentityAllowed("user_123", "user_456") === false,
    "a socket verified as user_123 is REJECTED when join-room claims user_456");
  assert(socketIdentity.isJoinIdentityAllowed("user_123", "") === false,
    "rejected when claimed userId is empty but socket has a verified identity");
}

console.log("=== isJoinIdentityAllowed: exploit scenario — claiming the room host's identity ===");
{
  // Regression for the exact scenario found in the audit: a socket that
  // verified as an ordinary user must not be able to join-room claiming
  // the host's userId to gain isOwnerOrAdmin() powers (kick/mute/lock/etc).
  const attackerAuthedUserId = "attacker_1";
  const hostUserId = "host_99";
  assert(socketIdentity.isJoinIdentityAllowed(attackerAuthedUserId, hostUserId) === false,
    "a verified attacker cannot join-room claiming the host's userId");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
