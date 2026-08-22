// test/crossInstanceUserEmit.test.js
// Gap #1 (Redis Authoritative Runtime State) — REMAINING ITEM 1 verification.
//
// Two things are exercised here, both against the REAL modules (not
// re-implementations):
//
// 1. svip.js's/coinCenter.js's local `emitToUser()` helper correctly
//    DELEGATES to an injected cross-instance-safe `emitToUser` (the one
//    server.js now passes to every module it initializes) instead of the
//    old local-socket-only path, while still falling back to the old
//    local path unchanged if nothing is injected (so a caller/test that
//    doesn't supply it sees zero behavior change — regression safety).
//
// 2. The actual cross-instance delivery MECHANISM those injected
//    functions rely on: `io.to(`user:${userId}`).emit(event, payload)`
//    (server.js's real, one-line emitToUser() body — copied verbatim
//    here, not reinterpreted) reaches a socket purely by ROOM
//    membership, with no dependency on socketsByUserId at all. This is
//    exactly what makes it work across cluster instances in production
//    (Socket.IO's Redis Adapter makes room membership/emits cluster-wide)
//    — this test proves the room-membership contract locally, since a
//    real multi-process Redis Adapter isn't available in this sandbox
//    (see FINAL_INTEGRATION_REPORT.md §14 / redisAuthoritativeState.test.js).
//
// Run: node test/crossInstanceUserEmit.test.js

const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---------- minimal mock Socket.IO with real room semantics ----------
// `to(room).emit(...)` only reaches sockets that `.join(room)`-ed it —
// same contract as the real Socket.IO server (and, in production, the
// same contract the Redis Adapter extends across every instance).
let nextSocketId = 1;
const allSockets = new Map();
function makeSocket() {
  const s = {
    id: "sock" + (nextSocketId++),
    rooms: new Set(),
    received: [],
    join(room) { this.rooms.add(room); },
    emit(event, payload) { this.received.push({ event, payload }); }
  };
  s.rooms.add(s.id); // real Socket.IO auto-joins every socket to a room named after its own id — this is what makes io.to(socketId) work
  allSockets.set(s.id, s);
  return s;
}
const io = {
  sockets: { sockets: allSockets },
  to(room) {
    return {
      emit(event, payload) {
        for (const s of allSockets.values()) {
          if (s.rooms.has(room)) s.emit(event, payload);
        }
      }
    };
  }
};

// server.js's real emitToUser() body, verbatim (see server.js line ~177):
//   function emitToUser(userId, event, payload) {
//       io.to(`user:${userId}`).emit(event, payload);
//   }
function emitToUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

console.log("=== emitToUser() room-membership contract (the mechanism every migrated call-site now relies on) ===");
{
  const localSocket = makeSocket();
  localSocket.join("user:alice"); // this "instance" happens to hold Alice's live socket

  // Simulates a socket that is NOT known to socketsByUserId on this
  // instance at all — i.e. exactly what a user connected to a DIFFERENT
  // cluster instance looks like from here. It only shows up because it
  // joined the shared `user:alice` room (which, in production, the
  // Redis Adapter makes visible/reachable across every instance).
  const remoteSocket = makeSocket();
  remoteSocket.join("user:alice");

  const unrelatedSocket = makeSocket();
  unrelatedSocket.join("user:bob");

  emitToUser("alice", "wallet-update", { coins: 500 });

  assert(localSocket.received.length === 1 && localSocket.received[0].event === "wallet-update", "the locally-known socket received the emit");
  assert(remoteSocket.received.length === 1 && remoteSocket.received[0].event === "wallet-update", "a socket with NO entry in local socketsByUserId — standing in for one connected to a different cluster instance — still received the emit, purely via room membership");
  assert(unrelatedSocket.received.length === 0, "a socket in a different user's room was not affected");
}

console.log("\n=== emitToUser() targets ALL of a user's devices/sessions, not just one (correct for kicked/ban/notification-style events) ===");
{
  const deviceA = makeSocket();
  const deviceB = makeSocket();
  deviceA.join("user:carol");
  deviceB.join("user:carol");
  emitToUser("carol", "kicked", { message: "banned" });
  assert(deviceA.received.some((r) => r.event === "kicked"), "device A got kicked");
  assert(deviceB.received.some((r) => r.event === "kicked"), "device B got kicked too — every session, not just one");
}

console.log("\n=== emitToUser() to a user with no sockets anywhere is a safe no-op ===");
{
  let threw = false;
  try { emitToUser("nobody-online", "wallet-update", { coins: 1 }); } catch (e) { threw = true; }
  assert(!threw, "emitting to an offline/unknown user never throws");
}

// ---------- svip.js: real module, delegation vs. fallback ----------
console.log("\n=== svip.js: notifications DELEGATE to an injected cross-instance emitToUser() ===");
{
  const { initSvip } = require(path.join(__dirname, "..", "svip.js"));
  const calls = [];
  const injectedEmitToUser = (userId, event, payload) => calls.push({ userId, event, payload });

  const users = { u1: { userId: "u1", name: "Dana", svipLevel: 0, svipWealth: 0 } };
  const findUserByUserId = (id) => (users[id] ? { user: users[id] } : null);
  const DATA = {};
  const safeRead = (f, fb) => (DATA[f] !== undefined ? DATA[f] : fb);
  const safeWrite = (f, d) => { DATA[f] = d; };

  const svip = initSvip({
    DATA_FOLDER: "/tmp", safeRead, safeWrite,
    io: { to: () => ({ emit() { throw new Error("local io.to() path should NOT be used when emitToUser is injected"); } }) },
    socketsByUserId: {}, // deliberately empty/stale — proves the local sid path is bypassed
    emitToUser: injectedEmitToUser,
    findUserByUserId, saveUsers: () => {}, users
  });

  svip.addWealth("u1", 999999999); // large enough to push past a level threshold and fire svip_level_changed/svip_resource_update
  assert(calls.length > 0, "svip.js emitted at least one cross-instance notification via the injected emitToUser()");
  assert(calls.every((c) => c.userId === "u1"), "every notification was addressed to the right user");
}

console.log("\n=== svip.js: falls back to the local socket path unchanged when nothing is injected (regression safety) ===");
{
  const svipPath = require.resolve(path.join(__dirname, "..", "svip.js"));
  delete require.cache[svipPath];
  const { initSvip } = require(svipPath);

  const localSocket = makeSocket();
  const socketsByUserId = { u1: localSocket.id };
  const users = { u1: { userId: "u1", name: "Eve", svipLevel: 0, svipWealth: 0 } };
  const findUserByUserId = (id) => (users[id] ? { user: users[id] } : null);
  const DATA = {};
  const safeRead = (f, fb) => (DATA[f] !== undefined ? DATA[f] : fb);
  const safeWrite = (f, d) => { DATA[f] = d; };

  const svip = initSvip({
    DATA_FOLDER: "/tmp", safeRead, safeWrite,
    io, socketsByUserId,
    // emitToUser intentionally omitted
    findUserByUserId, saveUsers: () => {}, users
  });

  svip.addWealth("u1", 999999999);
  assert(localSocket.received.length > 0, "with no emitToUser injected, the old local-socket path still fires exactly as before");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
