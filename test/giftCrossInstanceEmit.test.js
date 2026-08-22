// test/giftCrossInstanceEmit.test.js
// Gap #1 (Redis Authoritative Runtime State) — REMAINING ITEM 1/3
// verification: the gift-triggered notifications in agencyHost.js
// (host-stats-update / host-gift-received / agency-stats-update, fired
// from registerGiftRecordedHook() every time server.js records a real
// gift) now reach the host/agency-owner regardless of which cluster
// instance their socket is connected to, via the injected emitToUser()
// — not the old socketsByUserId[hostId]-gated local-only io.to(sid).
//
// Exercises the REAL agencyHost.js module (not a re-implementation) with
// a minimal fake `app`/deps, same technique as the project's existing
// module tests. A tiny fake emitToUser() records every call so the
// assertions below can check exactly who a gift notification was
// addressed to, without needing a real Socket.IO/Redis adapter.
//
// Run: node test/giftCrossInstanceEmit.test.js

const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

const { initAgencyHost } = require(path.join(__dirname, "..", "agencyHost.js"));

// ---------- minimal fakes ----------
const routes = {}; // not exercised by these tests, just needs to exist
const fakeApp = { get: () => {}, post: () => {}, delete: () => {} };

const users = {
  m_host1: { userId: "host1", name: "HostOne", photo: "", agencyId: "agencyA", isHost: true, followersList: [] },
};
function findUserByUserId(userId) {
  const key = Object.keys(users).find((k) => users[k].userId === userId);
  return key ? { mobile: key, user: users[key] } : null;
}

const agencies = {
  agencyA: { agencyId: "agencyA", name: "Agency A", ownerUserId: "owner1", hostIds: ["host1"], commissionRate: 0.1, earnedDiamonds: 0 },
};

// Cross-instance-safe emit — the thing under test. Records every call so
// assertions can inspect exactly what was sent to whom, instead of
// relying on a real per-instance socketsByUserId map (which is exactly
// the local-only mechanism this migration replaced for these events).
const emittedTo = []; // { userId, event, payload }
function fakeEmitToUser(userId, event, payload) {
  emittedTo.push({ userId, event, payload });
}

let capturedHook = null;
function registerGiftRecordedHook(fn) { capturedHook = fn; }

initAgencyHost({
  app: fakeApp, io: { to: () => ({ emit: () => {} }) }, DATA_FOLDER: "/tmp",
  safeRead: (file, fallback) => fallback, safeWrite: () => {},
  users, findUserByUserId, saveUsers: () => {},
  agencies, saveAgencies: () => {},
  rooms: {}, socketsByUserId: {}, emitToUser: fakeEmitToUser,
  giftHistory: [], registerGiftRecordedHook, periodStart: () => 0,
  privateMessages: {}, saveMessages: () => {}, conversationKey: (a, b) => [a, b].sort().join("_"),
  INSTANT_EXCHANGE_RATE: 100,
});

console.log("\n1. A recorded gift notifies the host via emitToUser() — cross-instance-safe, not socketsByUserId-gated");
assert(typeof capturedHook === "function", "agencyHost.js registered its gift-recorded hook");

emittedTo.length = 0;
capturedHook({ hostId: "host1", agencyId: "agencyA", giftId: "g1", diamonds: 50, senderId: "u1", timestamp: new Date().toISOString() });

const hostEvents = emittedTo.filter((e) => e.userId === "host1");
assert(hostEvents.some((e) => e.event === "host-stats-update"), "host1 was sent host-stats-update via emitToUser()");
assert(hostEvents.some((e) => e.event === "host-gift-received"), "host1 was sent host-gift-received via emitToUser()");

const ownerEvents = emittedTo.filter((e) => e.userId === "owner1");
assert(ownerEvents.some((e) => e.event === "agency-stats-update"), "the agency OWNER (a different user than the host) was separately notified via emitToUser()");
assert(ownerEvents[0].payload.agencyId === "agencyA", "the agency notification carries the right agencyId");

console.log("\n2. A gift with no agencyId only notifies the host, never throws trying to resolve a nonexistent agency owner");
emittedTo.length = 0;
let threw = false;
try {
  capturedHook({ hostId: "host1", agencyId: null, giftId: "g2", diamonds: 10, senderId: "u2", timestamp: new Date().toISOString() });
} catch (e) { threw = true; }
assert(!threw, "hook with no agencyId completes without throwing");
assert(emittedTo.some((e) => e.userId === "host1" && e.event === "host-gift-received"), "host still notified");
assert(!emittedTo.some((e) => e.event === "agency-stats-update"), "no agency-stats-update fired when there's no agency to notify");

console.log("\n3. A gift for a host with no recorded entries yet still delivers (first-ever gift) — no crash on an empty giftHistoryByHost bucket");
emittedTo.length = 0;
threw = false;
try {
  capturedHook({ hostId: "brand-new-host", agencyId: null, giftId: "g3", diamonds: 5, senderId: "u3", timestamp: new Date().toISOString() });
} catch (e) { threw = true; }
assert(!threw, "first-ever gift for a host does not throw");
assert(emittedTo.some((e) => e.userId === "brand-new-host" && e.event === "host-stats-update"), "brand-new host still gets host-stats-update via emitToUser()");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
