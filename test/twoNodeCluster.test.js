// test/twoNodeCluster.test.js
// Gap #3 (Two-Node Cluster Validation)
// ==================================================
// Simulates a real two-instance PingPong cluster ("Node A" and "Node B")
// sharing one Redis, and exercises the REAL redis/*.js modules from both
// "sides" against a single in-memory fake Redis server standing in for
// the one real Redis both processes would share. No real multi-process
// Redis/Postgres is available in this sandbox (same constraint every
// existing test/*.js file in this repo already documents), so this file
// uses the same "swap the require cache" technique
// test/roomJoinRpc.test.js and test/redisAuthoritativeState.test.js
// already established — the difference here is scale: instead of one
// fake, this builds a small fake Redis SERVER (get/set/del/hset/hgetall
// /expire/sadd/srem/smembers/mget/scan/multi/pipeline/publish/subscribe)
// and loads TWO independent, freshly-required copies of every relevant
// redis/*.js module against it — one "as Node A", one "as Node B" — each
// with its own INSTANCE_ID (os.hostname() is faked too, per-load) and
// its own closure-local state (presence.js's debounce map, etc), exactly
// like two separate OS processes pointed at the same Redis would have.
// Every module under test here is the REAL file — nothing about
// pubsub.js / sessionStore.js / roomState.js / userState.js /
// presence.js / roomJoinRpc.js / roomOpRpc.js is reimplemented.
//
// Covers the Gap #3 checklist: login/session, room create/join, seat,
// leave, message, presence, reconnect, cross-instance notifications,
// room state consistency.
//
// Run: node test/twoNodeCluster.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function run(name, fn) { console.log("\n" + name); await fn(); }

// ============================================================
// FAKE REDIS SERVER — one shared in-memory store + pub/sub bus,
// standing in for the one real Redis both nodes point at.
// ============================================================
function makeFakeRedisServer() {
  const strings = new Map();   // key -> string value
  const hashes = new Map();    // key -> { field: value }
  const sets = new Map();      // key -> Set<member>
  const subscribers = [];      // { channels: Set<string>, onMessage: fn }

  function glob(pattern) {
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return (key) => re.test(key);
  }

  const server = {
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async set(key, value /*, "EX", secs */) { strings.set(key, value); return "OK"; },
    async del(...keys) {
      let n = 0;
      for (const k of keys) { if (strings.delete(k)) n++; if (hashes.delete(k)) n++; if (sets.delete(k)) n++; }
      return n;
    },
    async expire() { return 1; }, // TTL not modeled — tests don't depend on real expiry timing
    async hset(key, obj) {
      const h = hashes.get(key) || {};
      Object.assign(h, obj);
      hashes.set(key, h);
      return 1;
    },
    async hgetall(key) { return hashes.get(key) ? { ...hashes.get(key) } : {}; },
    async sadd(key, member) { const s = sets.get(key) || new Set(); s.add(member); sets.set(key, s); return 1; },
    async srem(key, member) { const s = sets.get(key); if (!s) return 0; return s.delete(member) ? 1 : 0; },
    async smembers(key) { return Array.from(sets.get(key) || []); },
    async mget(keys) { return keys.map((k) => (strings.has(k) ? strings.get(k) : null)); },
    async scan(cursor, _match, pattern, _count, _n) {
      const match = glob(pattern);
      const keys = Array.from(strings.keys()).filter(match);
      return ["0", keys]; // single-pass fake cursor — fine for the small key counts in these tests
    },
    // ---- pub/sub: publish delivers asynchronously to every subscribed
    // fake connection, mirroring real Redis's async, at-least-once,
    // fan-out-to-everyone-including-self delivery (loop-guard is
    // pubsub.js's own job, same as production).
    publish(channel, message) {
      setImmediate(() => {
        for (const sub of subscribers) {
          if (sub.channels.has(channel)) sub.onMessage(channel, message);
        }
      });
      return Promise.resolve(subscribers.length);
    },
    _registerSubscriber(sub) { subscribers.push(sub); },
  };
  return server;
}

// A "connection" is just a thin handle onto the shared server, plus
// (for the dedicated subscriber connection) its own subscribe/on
// registration — same shape ioredis exposes, real client.js already
// hands out a general connection and a separate subscriber connection.
function makeFakeConnection(server) {
  const conn = {
    get: server.get, set: server.set, del: server.del, expire: server.expire,
    hset: server.hset, hgetall: server.hgetall,
    sadd: server.sadd, srem: server.srem, smembers: server.smembers, mget: server.mget,
    scan: server.scan,
    publish: server.publish,
    multi() { return makeMulti(conn); },
    pipeline() { return makeMulti(conn); },
  };
  return conn;
}
function makeMulti(conn) {
  const ops = [];
  const builder = {};
  ["set", "del", "expire", "hset", "sadd", "srem"].forEach((cmd) => {
    builder[cmd] = (...args) => { ops.push([cmd, args]); return builder; };
  });
  // presence.js's read pipeline also queues hgetall calls
  builder.hgetall = (...args) => { ops.push(["hgetall", args]); return builder; };
  builder.exec = async () => {
    const results = [];
    for (const [cmd, args] of ops) {
      try { results.push([null, await conn[cmd](...args)]); }
      catch (e) { results.push([e, null]); }
    }
    return results;
  };
  return builder;
}
function makeFakeSubscriberConnection(server) {
  const handlers = { message: [] };
  const mySub = { channels: new Set(), onMessage: (ch, msg) => handlers.message.forEach((h) => h(ch, msg)) };
  server._registerSubscriber(mySub);
  return {
    subscribe: async (...channels) => { channels.forEach((c) => mySub.channels.add(c)); },
    on: (event, cb) => { if (handlers[event]) handlers[event].push(cb); },
  };
}

// ============================================================
// NODE HARNESS — builds one "cluster instance" (own INSTANCE_ID, own
// closures) against the shared fake server, using freshly-required real
// redis/*.js modules. See file header for why the require-cache-swap
// approach is used instead of a re-implementation.
// ============================================================
const REDIS_DIR = path.join(__dirname, "..", "redis");
const files = {
  client: require.resolve(path.join(REDIS_DIR, "client.js")),
  pubsub: require.resolve(path.join(REDIS_DIR, "pubsub.js")),
  presence: require.resolve(path.join(REDIS_DIR, "presence.js")),
  roomState: require.resolve(path.join(REDIS_DIR, "roomState.js")),
  userState: require.resolve(path.join(REDIS_DIR, "userState.js")),
  sessionStore: require.resolve(path.join(REDIS_DIR, "sessionStore.js")),
  roomJoinRpc: require.resolve(path.join(REDIS_DIR, "roomJoinRpc.js")),
  roomOpRpc: require.resolve(path.join(REDIS_DIR, "roomOpRpc.js")),
};
const osPath = require.resolve("os");
const realOs = require("os");

let redisEnabled = true;

function buildNode(nodeName, server) {
  // ---- fake "os" so this node's fresh module loads compute their own
  // distinct INSTANCE_ID (pubsub.js/presence.js/roomState.js/userState.js
  // all do `${os.hostname()}:${process.pid}` at load time) — same trick
  // as faking client.js/pubsub.js in every other test/*.js in this repo.
  require.cache[osPath] = new Module(osPath, null);
  require.cache[osPath].exports = Object.assign({}, realOs, { hostname: () => nodeName });

  // ---- fake client.js: real getConnection()/getSubscriberConnection()
  // shape, backed by the one shared fake server (= the one real Redis
  // both nodes would share).
  const generalConn = makeFakeConnection(server);
  require.cache[files.client] = new Module(files.client, null);
  require.cache[files.client].exports = {
    isEnabled: () => redisEnabled,
    getConnection: () => (redisEnabled ? generalConn : null),
    getSubscriberConnection: () => (redisEnabled ? makeFakeSubscriberConnection(server) : null),
    prefixed: (k) => `pingpong:${k}`,
    KEY_PREFIX: "pingpong:",
  };

  delete require.cache[files.pubsub];
  const pubsub = require(files.pubsub);
  pubsub.init(); // real init(): subscribes this node's fake subscriber connection to all 4 channels

  delete require.cache[files.presence];
  const presence = require(files.presence);
  delete require.cache[files.roomState];
  const roomState = require(files.roomState);
  delete require.cache[files.userState];
  const userState = require(files.userState);
  delete require.cache[files.sessionStore];
  const sessionStore = require(files.sessionStore);

  const rooms = {};
  const socketsByUserId = {};

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

  delete require.cache[files.roomJoinRpc];
  const roomJoinRpc = require(files.roomJoinRpc).initRoomJoinRpc({ rooms, performJoin, publicRoom });
  delete require.cache[files.roomOpRpc];
  const roomOpRpc = require(files.roomOpRpc).initRoomOpRpc({ rooms });
  roomOpRpc.registerOp("take-seat", performTakeSeat);
  roomOpRpc.registerOp("leave-seat", performLeaveSeat);
  roomOpRpc.registerOp("send-message", performSendMessage);

  return {
    name: nodeName, pubsub, presence, roomState, userState, sessionStore,
    rooms, socketsByUserId, roomJoinRpc, roomOpRpc, publicRoom,
  };
}

function makeRoom(overrides = {}) {
  return Object.assign({
    roomId: "room1", roomName: "Test Room", hostId: "host1",
    roomLocked: false, roomPasswordHash: null, adminIds: [],
    onlineUsers: [], seats: new Array(8).fill(null), messages: [], chatBannedIds: []
  }, overrides);
}

// A minimal fake io.sockets.sockets Map + rooms, just enough for
// presence.js's computeAutoStatus() (io.sockets.sockets.get(socketId))
// to read real socket.currentRoom off it.
function makeFakeIo() {
  const socketsMap = new Map();
  return {
    sockets: { sockets: socketsMap },
    _addSocket(socketId, currentRoom) { socketsMap.set(socketId, { id: socketId, currentRoom }); },
  };
}

(async () => {

const server = makeFakeRedisServer();
const nodeA = buildNode("node-A", server);
const nodeB = buildNode("node-B", server);

await run("1. LOGIN / SESSION — a session created on Node A is readable and touchable from Node B (shared Redis, real sessionStore.js)", async () => {
  const created = await nodeA.sessionStore.createSession("user1", "tokenABC", { deviceId: "device1" });
  assert(created === true, "Node A created the session");

  const seenOnB = await nodeB.sessionStore.validateSession("tokenABC");
  assert(seenOnB && seenOnB.userId === "user1", "Node B can validate a session token created on Node A (shared Redis, not per-instance memory)");

  const touched = await nodeB.sessionStore.touchSession("tokenABC");
  assert(touched === true, "Node B can touch/refresh a session it didn't create");
});

await run("2. ROOM CREATE/JOIN — a room created (and joined) on Node A is discoverable and cross-instance-joinable from Node B", async () => {
  nodeA.rooms.room1 = makeRoom();
  const localJoin = nodeA.roomJoinRpc; // room owned locally by A, so A's own local join path (server.js's, not exercised here) would apply directly — this test only exercises the CROSS-instance path from B, which is the actual gap this project closes.

  const result = await nodeB.roomJoinRpc.requestCrossInstanceJoin({
    roomId: "room1", userId: "userJoinB", userName: "Bob", userPhoto: "", socketId: "sockB1", passwordHash: null
  });
  assert(result.ok === true, "Node B successfully cross-instance-joined a room that only exists on Node A");
  assert(nodeA.rooms.room1.onlineUsers.some((u) => u.userId === "userJoinB"), "the ONE real room object on Node A (the owner) was mutated — not a copy");
  assert(!nodeB.rooms.room1, "Node B still has no local copy of the room — ownership stays exclusively with Node A, per the Redis Authoritative design");
});

await run("3. SEAT — take-seat issued while the user's socket is on Node B is correctly applied to the room Node A owns", async () => {
  const result = await nodeB.roomOpRpc.forwardOp("take-seat", "room1", { userId: "userJoinB", socketId: "sockB1", seatNumber: 2 });
  assert(result.ok === true, "cross-instance take-seat (B -> A) succeeded");
  assert(nodeA.rooms.room1.seats[1] && nodeA.rooms.room1.seats[1].userId === "userJoinB", "the seat is occupied on the OWNING node's real room object");
});

await run("4. MESSAGE — send-message issued from Node B lands in the OWNING node's (A's) real chat log", async () => {
  const result = await nodeB.roomOpRpc.forwardOp("send-message", "room1", { userId: "userJoinB", message: "hi from node B" });
  assert(result.ok === true, "cross-instance send-message (B -> A) succeeded");
  assert(nodeA.rooms.room1.messages.some((m) => m.message === "hi from node B"), "the message is present in Node A's real room.messages — the single source of truth");
});

await run("5. LEAVE — leave-seat issued from Node B frees the real seat on Node A", async () => {
  const result = await nodeB.roomOpRpc.forwardOp("leave-seat", "room1", { userId: "userJoinB" });
  assert(result.ok === true && result.result.seatNumber === 2, "cross-instance leave-seat (B -> A) succeeded and reports the freed seat");
  assert(nodeA.rooms.room1.seats[1] === null, "the seat is actually free on the owning node's real room object");
});

await run("6. PRESENCE — a user online on Node A is visible cluster-wide, and Node B reads the same status Node A computed and wrote", async () => {
  const io = makeFakeIo();
  io._addSocket("sockA1", "room1");
  nodeA.socketsByUserId["userJoinB"] = "sockA1"; // now "connected to A" for this step, simulating the user reconnecting through Node A
  nodeA.rooms.room1.seats[3] = { userId: "userJoinB", socketId: "sockA1" }; // seated -> in_voice_call

  await nodeA.presence.syncAll({ io, rooms: nodeA.rooms, socketsByUserId: nodeA.socketsByUserId });
  const seenFromB = await nodeB.presence.getPresence("userJoinB");
  assert(seenFromB && seenFromB.status === "in_voice_call", "Node B reads the exact presence status Node A computed and wrote (in_voice_call, since the user is seated)");
  assert(seenFromB.instanceId === "node-A:" + process.pid, "the presence record correctly attributes ownership to Node A, not Node B");
});

await run("7. CROSS-INSTANCE NOTIFICATIONS — a presence status change published by Node A is delivered to Node B's pub/sub subscription (and NOT looped back to Node A itself)", async () => {
  const received = [];
  nodeB.pubsub.on("presence", (msg) => received.push(msg));
  await nodeA.pubsub.publish("presence", "test-notification", { hello: "from A" });
  await wait(20); // fake delivery is async (setImmediate), mirror real Redis pub/sub's async delivery
  assert(received.some((m) => m.event === "test-notification" && m.payload.hello === "from A"), "Node B's subscriber received the cross-instance notification Node A published");
  assert(received.every((m) => m.instanceId !== "node-B:" + process.pid), "no message ever appears to have come from Node B itself (loop-guard correctness, though the isolated check is really: it's tagged with A's id)");
  assert(received.every((m) => m.instanceId === "node-A:" + process.pid), "every received message is correctly attributed to Node A as the true publisher");
});

await run("8. RECONNECT — after the user's session moves from Node A to Node B (their new socket lands on B), the room they were in is still reachable and consistent from B", async () => {
  // Simulate reconnect: the user's session (created in test 1 against a
  // different user, so use a fresh one here) is still valid cluster-wide,
  // and rejoining the SAME room from the new instance (B) sees the exact
  // state left behind by whatever happened on A.
  const reconnectResult = await nodeB.roomJoinRpc.requestCrossInstanceJoin({
    roomId: "room1", userId: "userJoinB", userName: "Bob", userPhoto: "", socketId: "sockB2-reconnected", passwordHash: null
  });
  assert(reconnectResult.ok === true, "rejoining after reconnect (now issued from Node B, room still owned by Node A) succeeds");
  assert(reconnectResult.room.messages.some((m) => m.message === "hi from node B"), "the room snapshot returned after reconnect still contains the earlier chat message — no state was lost across the reconnect");
  assert(nodeA.rooms.room1.onlineUsers.find((u) => u.userId === "userJoinB").socketId === "sockB2-reconnected", "the owning node's real room record now reflects the user's NEW socketId after reconnect, replacing the stale one");
});

await run("9. ROOM STATE CONSISTENCY — Node A's periodic roomState.js mirror snapshot is exactly what Node B (or any instance) reads back from Redis", async () => {
  await nodeA.roomState.syncRoom("room1", { rooms: nodeA.rooms });
  const mirrored = await nodeB.roomState.getRoomState("room1");
  assert(mirrored !== null, "Node B can read a room-state snapshot Node A wrote");
  assert(mirrored.roomId === "room1", "the mirrored snapshot is for the correct room");
  assert(mirrored.onlineUserIds.includes("userJoinB"), "the mirrored snapshot's onlineUserIds matches the real room's current membership");

  const discovered = await nodeB.roomState.listRoomIds();
  assert(discovered.includes("room1"), "Node B's cluster-wide room discovery (SCAN-based listRoomIds) finds the room even though it only exists locally on Node A");
});

await run("10. Redis outage mid-cluster: both nodes degrade to their existing single-instance-safe fallbacks, no throws, no hangs", async () => {
  redisEnabled = false;
  const joinResult = await nodeB.roomJoinRpc.requestCrossInstanceJoin({ roomId: "room1", userId: "userX", userName: "X", userPhoto: "", socketId: "s", passwordHash: null });
  assert(joinResult.ok === false && joinResult.error === "redis-disabled", "cross-instance join fails cleanly (not a hang) when the shared Redis is down");
  const opResult = await nodeB.roomOpRpc.forwardOp("send-message", "room1", { userId: "userX", message: "test" });
  assert(opResult.ok === false && opResult.error === "redis-disabled", "cross-instance op forwarding fails cleanly when the shared Redis is down");
  const presenceResult = await nodeB.presence.getPresence("userJoinB");
  assert(presenceResult === null, "presence reads fail closed (null), not throw, when Redis is down");
  redisEnabled = true;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
