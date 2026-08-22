// test/roomStateListRoomIds.test.js
// Gap #1 (Redis Authoritative Runtime State) — unit test for
// redis/roomState.js's new listRoomIds(), the cluster-wide room-discovery
// helper /api/room/list now uses (see server.js's
// roomListPublicCrossInstance()). No real Redis is available in this
// sandbox, so this mocks redis/client.js's connection surface with a tiny
// in-memory fake that implements just the SCAN semantics listRoomIds()
// actually uses.
//
// Run: node test/roomStateListRoomIds.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

const PREFIX = "pingpong:";
const fakeRedisKeys = [
  `${PREFIX}room:state:room-A`,
  `${PREFIX}room:state:room-B`,
  `${PREFIX}room:state:room-C`,
  `${PREFIX}user:state:some-user`, // must NOT show up — different key namespace
];

const fakeConn = {
  // Mimics ioredis's SCAN cursor protocol, paginated 2-at-a-time on
  // purpose so the do/while loop in listRoomIds() is actually exercised,
  // not just a single-page happy path.
  async scan(cursor, _match, pattern, _count, page) {
    const matching = fakeRedisKeys.filter((k) => {
      const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      return re.test(k);
    });
    const start = parseInt(cursor, 10);
    const pageSize = 2;
    const slice = matching.slice(start, start + pageSize);
    const nextCursor = start + pageSize >= matching.length ? "0" : String(start + pageSize);
    return [nextCursor, slice];
  },
  async get(key) {
    if (key === `${PREFIX}room:state:room-A`) {
      return JSON.stringify({ roomId: "room-A", roomName: "Room A", hostId: "h1", onlineUserIds: ["u1", "u2"] });
    }
    return null;
  },
};
const fakeClient = {
  isEnabled: () => true,
  getConnection: () => fakeConn,
  prefixed: (key) => `${PREFIX}${key}`,
};

const clientPath = require.resolve(path.join(__dirname, "..", "redis", "client.js"));
const roomStatePath = require.resolve(path.join(__dirname, "..", "redis", "roomState.js"));
require.cache[clientPath] = new Module(clientPath, null);
require.cache[clientPath].exports = fakeClient;
delete require.cache[roomStatePath];
const roomState = require(roomStatePath);

(async () => {
  console.log("=== listRoomIds: enumerates all room:state:* keys across pagination ===");
  {
    const ids = await roomState.listRoomIds();
    assert(ids.length === 3, `returns exactly 3 room ids (got ${ids.length})`);
    assert(ids.includes("room-A") && ids.includes("room-B") && ids.includes("room-C"), "returns the correct room ids, prefix stripped");
    assert(!ids.some((id) => id.includes("user:state")), "does not leak keys from a different namespace (user:state:*)");
  }

  console.log("=== listRoomIds + getRoomState: round-trip for a discovered id ===");
  {
    const ids = await roomState.listRoomIds();
    const snap = await roomState.getRoomState(ids.find((id) => id === "room-A"));
    assert(snap && snap.roomName === "Room A", "getRoomState resolves full snapshot for an id discovered via listRoomIds");
    assert(Array.isArray(snap.onlineUserIds) && snap.onlineUserIds.length === 2, "snapshot carries onlineUserIds for the merged room-list card");
  }

  console.log("=== listRoomIds: disabled Redis returns [] synchronously-safe, not an error ===");
  {
    fakeClient.isEnabled = () => false;
    const ids = await roomState.listRoomIds();
    assert(Array.isArray(ids) && ids.length === 0, "returns an empty array when Redis is disabled, never throws");
    fakeClient.isEnabled = () => true;
  }

  console.log("\n==================================================");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("==================================================");
  process.exit(fail === 0 ? 0 : 1);
})();
