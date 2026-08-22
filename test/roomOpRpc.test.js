// test/roomOpRpc.test.js
// Gap #2 (Cross-Instance Room Operation Forwarding) verification:
// take-seat / leave-seat / send-message forwarding (redis/roomOpRpc.js),
// plus room state consistency after the round trip.
//
// Same technique as test/roomJoinRpc.test.js: no real multi-process Redis
// cluster is available in this sandbox, so redis/pubsub.js and
// redis/client.js are swapped for small in-memory fakes via the require
// cache. redis/roomOpRpc.js itself is the REAL module, exercising its
// actual request/response/timeout/registerOp logic, not a
// re-implementation.
//
// Run: node test/roomOpRpc.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---------- fake pub/sub bus (identical contract to roomJoinRpc.test.js) ----------
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
      setImmediate(() => {
        busHandlers[category].slice().forEach((h) => { try { h(msg); } catch (e) { /* per-handler try/catch, matches real pubsub.js */ } });
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

const roomOpRpcPath = require.resolve(path.join(__dirname, "..", "redis", "roomOpRpc.js"));
delete require.cache[roomOpRpcPath];
const { initRoomOpRpc, RPC_TIMEOUT_MS } = require(roomOpRpcPath);

// ---------- realistic performers, matching server.js's real
// performTakeSeat/performLeaveSeat/performSendMessage contracts ----------
function makeRoom(overrides = {}) {
  return Object.assign({
    roomId: "room1", roomName: "Test Room", hostId: "host1",
    seats: new Array(8).fill(null), messages: [], chatBannedIds: [], lockedSeats: []
  }, overrides);
}

function performTakeSeat(room, { userId, socketId, seatNumber }) {
  if (room.seats[seatNumber - 1]) return { ok: false, error: "occupied", message: "Seat is already occupied" };
  room.seats[seatNumber - 1] = { userId, socketId };
  return { ok: true };
}
function performLeaveSeat(room, { userId }) {
  let seatNumber = null;
  room.seats.forEach((s, i) => { if (s && s.userId === userId) { seatNumber = i + 1; room.seats[i] = null; } });
  return { ok: true, seatNumber };
}
function performSendMessage(room, { userId, message }) {
  if ((room.chatBannedIds || []).includes(userId)) return { ok: false, error: "chat-banned", message: "You have been banned from chat" };
  room.messages.push({ userId, message });
  return { ok: true };
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function run(name, fn) { console.log("\n" + name); await fn(); }

(async () => {

await run("1. take-seat forwarded to the owning instance mutates the OWNER's real room object", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("take-seat", performTakeSeat);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} }); // instance A has nothing locally
  requester.registerOp("take-seat", performTakeSeat);

  const result = await requester.forwardOp("take-seat", "room1", { userId: "u1", socketId: "sockA1", seatNumber: 3 });

  assert(result.ok === true, "cross-instance take-seat reported success");
  assert(rooms.room1.seats[2] && rooms.room1.seats[2].userId === "u1", "the OWNING instance's real room object was actually mutated — seat 3 now holds u1");
});

await run("2. take-seat on an already-occupied seat is rejected with the same message a local rejection would give, and does NOT mutate the room", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  rooms.room1.seats[4] = { userId: "existing-user", socketId: "sockX" };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("take-seat", performTakeSeat);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("take-seat", performTakeSeat);

  const result = await requester.forwardOp("take-seat", "room1", { userId: "u2", socketId: "sockA2", seatNumber: 5 });
  assert(result.ok === false, "occupied seat correctly rejected over the RPC path");
  assert(result.result && result.result.message === "Seat is already occupied", "the exact user-facing message round-trips back to the requester");
  assert(rooms.room1.seats[4].userId === "existing-user", "the rejected op did NOT overwrite the existing occupant");
});

await run("3. leave-seat forwarded cross-instance frees the real seat on the owning instance", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  rooms.room1.seats[1] = { userId: "u3", socketId: "sockA3" };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("leave-seat", performLeaveSeat);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("leave-seat", performLeaveSeat);

  const result = await requester.forwardOp("leave-seat", "room1", { userId: "u3" });
  assert(result.ok === true && result.result.seatNumber === 2, "leave-seat reports the freed seat number");
  assert(rooms.room1.seats[1] === null, "the real seat is actually freed on the owning instance");
});

await run("4. send-message forwarded cross-instance appends to the OWNER's real message log", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("send-message", performSendMessage);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("send-message", performSendMessage);

  const result = await requester.forwardOp("send-message", "room1", { userId: "u4", message: "hello from another instance" });
  assert(result.ok === true, "cross-instance send-message succeeded");
  assert(rooms.room1.messages.length === 1 && rooms.room1.messages[0].message === "hello from another instance", "the message landed in the one real room.messages array on the owning instance");
});

await run("5. a chat-banned user's forwarded send-message is rejected and does NOT append a message", async () => {
  resetBus();
  const rooms = { room1: makeRoom({ chatBannedIds: ["banned-user"] }) };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("send-message", performSendMessage);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("send-message", performSendMessage);

  const result = await requester.forwardOp("send-message", "room1", { userId: "banned-user", message: "spam" });
  assert(result.ok === false && result.result.message === "You have been banned from chat", "chat-ban correctly rejected over the RPC path with the right message");
  assert(rooms.room1.messages.length === 0, "no message was appended for the rejected send");
});

await run("6. an op forwarded to an instance that never registered that op name resolves cleanly to ok:false (unknown-op), not a hang", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  const owner = initRoomOpRpc({ rooms }); // deliberately does NOT registerOp anything

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });

  const result = await requester.forwardOp("take-seat", "room1", { userId: "u5", socketId: "sockA5", seatNumber: 1 });
  assert(result.ok === false && result.error === "unknown-op", "resolves promptly to unknown-op instead of waiting out the full timeout");
});

await run("7. a room that genuinely doesn't exist anywhere in the cluster times out to ok:false", async () => {
  resetBus();
  initRoomOpRpc({ rooms: {} }); // owns nothing
  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("take-seat", performTakeSeat);

  const start = Date.now();
  const result = await requester.forwardOp("take-seat", "room-does-not-exist", { userId: "u6", socketId: "sockA6", seatNumber: 1 });
  const elapsed = Date.now() - start;
  assert(result.ok === false && result.error === "timeout", "resolves to a clean timeout, not a hang or a throw");
  assert(elapsed >= RPC_TIMEOUT_MS - 50, `waited out the real ${RPC_TIMEOUT_MS}ms timeout before giving up (took ${elapsed}ms)`);
});

await run("8. Redis disabled resolves instantly to ok:false without waiting for any timeout", async () => {
  resetBus();
  redisEnabled = false;
  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("take-seat", performTakeSeat);
  const start = Date.now();
  const result = await requester.forwardOp("take-seat", "room1", { userId: "u7", socketId: "sockA7", seatNumber: 1 });
  const elapsed = Date.now() - start;
  assert(result.ok === false && result.error === "redis-disabled", "immediately reports redis-disabled");
  assert(elapsed < 200, "did NOT wait out the RPC timeout");
  redisEnabled = true;
});

await run("9. two DIFFERENT ops (take-seat, send-message) forwarded concurrently to the same owning room both apply correctly with no cross-talk", async () => {
  resetBus();
  const rooms = { room1: makeRoom() };
  const owner = initRoomOpRpc({ rooms });
  owner.registerOp("take-seat", performTakeSeat);
  owner.registerOp("send-message", performSendMessage);

  currentInstanceId = "instance-A";
  const requester = initRoomOpRpc({ rooms: {} });
  requester.registerOp("take-seat", performTakeSeat);
  requester.registerOp("send-message", performSendMessage);

  const [seatRes, msgRes] = await Promise.all([
    requester.forwardOp("take-seat", "room1", { userId: "u8", socketId: "sockA8", seatNumber: 6 }),
    requester.forwardOp("send-message", "room1", { userId: "u9", message: "concurrent message" }),
  ]);

  assert(seatRes.ok && msgRes.ok, "both concurrent, different-typed forwarded ops succeeded");
  assert(rooms.room1.seats[5] && rooms.room1.seats[5].userId === "u8", "seat op applied to the right seat");
  assert(rooms.room1.messages.length === 1 && rooms.room1.messages[0].userId === "u9", "message op applied with the right sender, no cross-talk between the two requestIds");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
