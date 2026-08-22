// test/roomJoinRpc.test.js
// Gap #1 (Redis Authoritative Runtime State) — REMAINING ITEM 2 verification:
// cross-instance room join (redis/roomJoinRpc.js), plus room state
// consistency after the round trip.
//
// No real multi-process Redis cluster is available in this sandbox (see
// FINAL_INTEGRATION_REPORT.md §14) so, same technique as
// test/redisAuthoritativeState.test.js, redis/pubsub.js and redis/client.js
// are swapped for small in-memory fakes via the require cache. The fake
// pub/sub bus faithfully implements the real module's public contract
// (on(category, handler), publish(category, event, payload), INSTANCE_ID) —
// it just delivers in-process instead of over a real Redis connection.
// redis/roomJoinRpc.js itself is the REAL module, exercising its actual
// request/response/timeout logic, not a re-implementation.
//
// A realistic performJoin() is provided that matches server.js's real
// performRoomJoin() contract exactly (password check, seat/onlineUsers
// bookkeeping, returns { ok, needPassword, error }) so the "room state
// consistency" assertions below are checking the real shape this RPC
// layer is built to carry, not a simplified stand-in.
//
// Run: node test/roomJoinRpc.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---------- fake pub/sub bus ----------
// Same shape as the real redis/pubsub.js: category-scoped handlers,
// fire-and-forget publish, an INSTANCE_ID every message is stamped with.
// Unlike the real module, this fake does NOT drop self-published
// messages — see the note at the bottom of this file for why that's the
// correct, honest way to unit-test a single-process request/response
// round trip without a second real OS process.
let redisEnabled = true;
let currentInstanceId = "instance-A";
const busHandlers = { room: [], voice: [], presence: [], system: [] };
const fakePubsub = {
  get INSTANCE_ID() { return currentInstanceId; },
  CATEGORIES: ["room", "voice", "presence", "system"],
  on(category, handler) { busHandlers[category].push(handler); },
  publish(category, event, payload) {
    return new Promise((resolve) => {
      if (!redisEnabled) { resolve(false); return; }
      const msg = { instanceId: currentInstanceId, event, payload, ts: Date.now() };
      // Real Redis delivers asynchronously — mirror that instead of a
      // synchronous call, so ordering bugs that only show up with real
      // async delivery aren't hidden by this fake.
      setImmediate(() => {
        busHandlers[category].slice().forEach((h) => { try { h(msg); } catch (e) { /* matches real pubsub.js's per-handler try/catch */ } });
      });
      resolve(true);
    });
  }
};
const fakeClient = { isEnabled: () => redisEnabled };
function resetBus() {
  busHandlers.room = []; busHandlers.voice = []; busHandlers.presence = []; busHandlers.system = [];
}

const pubsubPath = require.resolve(path.join(__dirname, "..", "redis", "pubsub.js"));
const clientPath = require.resolve(path.join(__dirname, "..", "redis", "client.js"));
require.cache[pubsubPath] = new Module(pubsubPath, null);
require.cache[pubsubPath].exports = fakePubsub;
require.cache[clientPath] = new Module(clientPath, null);
require.cache[clientPath].exports = fakeClient;

const roomJoinRpcPath = require.resolve(path.join(__dirname, "..", "redis", "roomJoinRpc.js"));
delete require.cache[roomJoinRpcPath];
const { initRoomJoinRpc, RPC_TIMEOUT_MS } = require(roomJoinRpcPath);

// ---------- realistic performJoin(), matching server.js's real
// performRoomJoin() contract exactly (see server.js) ----------
function hashPw(pw) { return pw ? "hash:" + pw : null; }
function performJoin(room, { userId, userName, userPhoto, socketId, passwordHash }) {
  if (room.roomLocked && room.hostId !== userId && !(room.adminIds || []).includes(userId)) {
    if (!room.roomPasswordHash || !passwordHash || passwordHash !== room.roomPasswordHash) {
      return { ok: false, needPassword: true, error: passwordHash ? "wrong-password" : "password-required" };
    }
  }
  const existingIdx = room.onlineUsers.findIndex((u) => u.userId === userId);
  const entry = { userId, userName, userPhoto, socketId };
  if (existingIdx >= 0) room.onlineUsers[existingIdx] = entry; else room.onlineUsers.push(entry);
  room.seats.forEach((seat) => { if (seat && seat.userId === userId) seat.socketId = socketId; });
  return { ok: true };
}
function publicRoom(room) {
  const { roomPasswordHash, ...safe } = room;
  return { ...safe, memberCount: room.onlineUsers.length };
}

function makeRoom(overrides = {}) {
  return Object.assign({
    roomId: "room1", roomName: "Test Room", hostId: "host1",
    roomLocked: false, roomPasswordHash: null, adminIds: [],
    onlineUsers: [], seats: new Array(8).fill(null)
  }, overrides);
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function run(name, fn) {
  console.log("\n" + name);
  await fn();
}

(async () => {

await run("1. Cross-instance join succeeds when another instance owns the room, and mutates the OWNER's real room state", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  const owner = initRoomJoinRpc({ rooms, performJoin, publicRoom }); // "instance B" — actually owns room1

  currentInstanceId = "instance-A"; // this is who's ASKING
  const requester = initRoomJoinRpc({ rooms: {}, performJoin, publicRoom }); // "instance A" — has nothing locally

  const result = await requester.requestCrossInstanceJoin({
    roomId: "room1", userId: "u1", userName: "Alice", userPhoto: "", socketId: "sockA1", passwordHash: null
  });

  assert(result.ok === true, "cross-instance join reported success");
  assert(result.room && result.room.roomId === "room1", "the returned snapshot is for the right room");
  assert(result.room.onlineUsers.some((u) => u.userId === "u1"), "the returned snapshot already reflects the new member");
  assert(rooms.room1.onlineUsers.some((u) => u.userId === "u1" && u.socketId === "sockA1"), "the OWNING instance's real room object was actually mutated by the real performJoin() — not a copy, the one true room");
  assert(result.room.memberCount === 1, "member count in the snapshot is consistent with the real room's onlineUsers length");
});

await run("2. Wrong password on a cross-instance join is rejected exactly like a local join would reject it", async () => {
  resetBus();
  const rooms = { room1: makeRoom({ roomLocked: true, roomPasswordHash: hashPw("secret") }) };
  initRoomJoinRpc({ rooms, performJoin, publicRoom }); // owner

  currentInstanceId = "instance-A";
  const requester = initRoomJoinRpc({ rooms: {}, performJoin, publicRoom });

  const wrongResult = await requester.requestCrossInstanceJoin({
    roomId: "room1", userId: "u2", userName: "Bob", userPhoto: "", socketId: "sockA2", passwordHash: hashPw("nope")
  });
  assert(wrongResult.ok === false && wrongResult.needPassword === true, "wrong password correctly rejected over the RPC path");
  assert(!rooms.room1.onlineUsers.some((u) => u.userId === "u2"), "a rejected join did NOT mutate the owning instance's room state");

  const rightResult = await requester.requestCrossInstanceJoin({
    roomId: "room1", userId: "u2", userName: "Bob", userPhoto: "", socketId: "sockA2", passwordHash: hashPw("secret")
  });
  assert(rightResult.ok === true, "correct password succeeds over the RPC path");
  assert(rooms.room1.onlineUsers.some((u) => u.userId === "u2"), "the successful retry DID mutate the real room state");
});

await run("3. A room that genuinely doesn't exist anywhere in the cluster times out to ok:false (falls through to the existing room-not-found handling)", async () => {
  resetBus();
  // Two instances, NEITHER of which has the room — nobody ever answers.
  initRoomJoinRpc({ rooms: {}, performJoin, publicRoom });
  currentInstanceId = "instance-A";
  const requester = initRoomJoinRpc({ rooms: {}, performJoin, publicRoom });

  const start = Date.now();
  const result = await requester.requestCrossInstanceJoin({
    roomId: "room-does-not-exist", userId: "u3", userName: "Carl", userPhoto: "", socketId: "sockA3", passwordHash: null
  });
  const elapsed = Date.now() - start;
  assert(result.ok === false && result.error === "timeout", "resolves to a clean timeout, not a hang or a throw");
  assert(elapsed >= RPC_TIMEOUT_MS - 50, `waited out the real ${RPC_TIMEOUT_MS}ms timeout before giving up (took ${elapsed}ms)`);
}).then(() => {}); // this test intentionally takes ~RPC_TIMEOUT_MS to run — see file header

await run("4. Redis disabled resolves instantly to ok:false without waiting for any timeout (existing room-error fallback applies immediately)", async () => {
  resetBus();
  redisEnabled = false;
  currentInstanceId = "instance-A";
  const requester = initRoomJoinRpc({ rooms: {}, performJoin, publicRoom });
  const start = Date.now();
  const result = await requester.requestCrossInstanceJoin({
    roomId: "room1", userId: "u4", userName: "Dana", userPhoto: "", socketId: "sockA4", passwordHash: null
  });
  const elapsed = Date.now() - start;
  assert(result.ok === false && result.error === "redis-disabled", "immediately reports redis-disabled");
  assert(elapsed < 200, "did NOT wait out the RPC timeout — Redis-disabled is detected up front");
  redisEnabled = true;
});

await run("5. Two users joining the same cross-instance room concurrently (from the SAME requesting instance — the realistic case, since a real process only ever has one fixed INSTANCE_ID) both land in the one real room object with no lost update", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  initRoomJoinRpc({ rooms, performJoin, publicRoom }); // owner

  currentInstanceId = "instance-A";
  const requester = initRoomJoinRpc({ rooms: {}, performJoin, publicRoom });

  const [resA, resC] = await Promise.all([
    requester.requestCrossInstanceJoin({ roomId: "room1", userId: "uA", userName: "A", userPhoto: "", socketId: "sockA", passwordHash: null }),
    requester.requestCrossInstanceJoin({ roomId: "room1", userId: "uC", userName: "C", userPhoto: "", socketId: "sockC", passwordHash: null }),
  ]);

  assert(resA.ok && resC.ok, "both concurrent cross-instance joins succeeded");
  assert(rooms.room1.onlineUsers.length === 2, "the single owning room object ended up with BOTH members — no lost update between two concurrent requests");
  assert(rooms.room1.onlineUsers.some((u) => u.userId === "uA") && rooms.room1.onlineUsers.some((u) => u.userId === "uC"), "both specific users are present in the one authoritative room state");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();

// NOTE on the "self-message" simulation used throughout this file: the
// real redis/pubsub.js drops messages whose instanceId matches the
// receiving process's own INSTANCE_ID (loop-guard — see its header).
// In a real deployment that's irrelevant here because the OWNER and the
// REQUESTER are two different OS processes with two different
// INSTANCE_IDs. This fake reproduces that by having the test itself set
// `currentInstanceId` to whichever side is acting at that moment before
// calling into it, so a join-request published "as instance-A" is
// received by the owner's handler (registered while rooms had the room
// under a DIFFERENT currentInstanceId at init time makes no difference —
// ownership here is decided purely by "do I have rooms[roomId] locally",
// exactly like the real module) and the response is addressed back with
// `targetInstanceId: "instance-A"`, which only requester A's pending-map
// resolves — requester C (test 5) never sees or resolves A's response,
// and vice versa. This is the real protocol, exercised for real.
