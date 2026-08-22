// test/friendshipCpVisual.test.js
// Friendship/CP seat-adjacency fix + Admin Panel visual config (2026-08-11)
// regression test. Exercises the real friendshipCp.js module against a
// lightweight in-memory mock of its server.js dependencies (app/io/users/
// safeRead/safeWrite), the same pattern the rest of this suite uses for
// modules that can't be require()'d standalone with a live Express/Socket.IO
// server in this sandbox.
//
// Run: node test/friendshipCpVisual.test.js

const path = require("path");
const os = require("os");
const fs = require("fs");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

const DATA_FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), "pp-rel-test-"));
const ASSET_FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), "pp-rel-assets-"));

// ---------- minimal mocks ----------
const diskStore = {};
function safeRead(file, fallback) { return diskStore[file] !== undefined ? diskStore[file] : fallback; }
function safeWrite(file, data) { diskStore[file] = JSON.parse(JSON.stringify(data)); }

const users = {
  "1111111111": { userId: "u_a", user: { userId: "u_a", name: "Alice", coins: 10_000_000 } },
  "2222222222": { userId: "u_b", user: { userId: "u_b", name: "Bob", coins: 10_000_000 } }
};
function findUserByUserId(id) {
  return Object.values(users).find((u) => u.userId === id) || null;
}
function saveUsers() {}
function clampCoinBalance(_uid, val) { return Math.max(0, val); }
function logTransaction() {}
function pushWalletUpdate() {}
const emittedToUser = [];
function emitToUser(uid, event, data) { emittedToUser.push({ uid, event, data }); }
const privateMessages = {};
function saveMessages() {}
function conversationKey(a, b) { return [a, b].sort().join("_"); }

const routes = []; // [{method, pattern:RegExp, paramNames:[], handlers:[]}]
const mockApp = {
  get(p, ...handlers) { routes.push(routeEntry("GET", p, handlers)); },
  post(p, ...handlers) { routes.push(routeEntry("POST", p, handlers)); }
};
function routeEntry(method, p, handlers) {
  const paramNames = [];
  const regexStr = "^" + p.replace(/:[^/]+/g, (m) => { paramNames.push(m.slice(1)); return "([^/]+)"; }) + "$";
  return { method, pattern: new RegExp(regexStr), paramNames, handlers };
}
function callRoute(method, p, req) {
  const route = routes.find((r) => r.method === method && r.pattern.test(p));
  if (!route) throw new Error("no route " + method + " " + p);
  const match = p.match(route.pattern);
  req.params = req.params || {};
  route.paramNames.forEach((name, i) => { req.params[name] = match[i + 1]; });
  const chain = route.handlers;
  const res = { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
  let i = 0;
  function next() { i++; if (i < chain.length) chain[i](req, res, next); }
  chain[0](req, res, next);
  return res;
}

const userAuth = { requireUserAuth: (req, res, next) => next() };
let adminAllowed = true;
function requireAdmin(req, res, next) { if (!adminAllowed) return res.status(403).json({ success: false }); req.adminAccount = "test-admin"; next(); }
function requirePermission() { return (req, res, next) => next(); }

const emittedIo = [];
const io = {
  to() { return { emit() {} }; },
  emit(event, data) { emittedIo.push({ event, data }); }
};

// multer-like mock: single('asset') just reads req._fakeFile onto req.file
const uploadRelationshipAsset = {
  single() {
    return (req, res, next) => {
      if (req._fakeFile) {
        const filename = Date.now() + "-fake.png";
        fs.writeFileSync(path.join(ASSET_FOLDER, filename), "fake-png-bytes");
        req.file = { filename, originalname: req._fakeFile };
      }
      next();
    };
  }
};

const { initFriendshipCp } = require(path.join(__dirname, "..", "friendshipCp.js"));

const rooms = {};
function getRooms() { return rooms; }

const friendshipCp = initFriendshipCp({
  app: mockApp, DATA_FOLDER, safeRead, safeWrite,
  findUserByUserId, saveUsers, clampCoinBalance, logTransaction,
  users, userAuth, io,
  pushWalletUpdate, emitToUser, privateMessages, saveMessages, conversationKey,
  getRooms,
  requireAdmin, requirePermission, uploadRelationshipAsset, RELATIONSHIP_ASSET_FOLDER: ASSET_FOLDER,
  rbac: { logAction() {} }, reqUserAgent: () => "test-agent"
});

// ---------- helpers ----------
function makeRoom(roomId, seatAssignments) {
  // seatAssignments: { seatNumber: {userId, userName} }
  const seats = Array(8).fill(null);
  Object.entries(seatAssignments).forEach(([num, u]) => { seats[Number(num) - 1] = u; });
  const room = { roomId, seats };
  rooms[roomId] = room;
  return room;
}

async function establishRelationship(type) {
  const send = await friendshipCp.sendRequest("u_a", "u_b", type);
  assert(send.success, `${type} request sends successfully`);
  const respond = await friendshipCp.respondRequest("u_b", send.request.requestId, "accept");
  assert(respond.success && respond.status === "accepted", `${type} request accepted`);
}

(async () => {
  console.log("=== TEST 1/2: CP users in adjacent vs non-adjacent seats ===");
  await establishRelationship("cp");
  {
    const room = makeRoom("room1", { 1: { userId: "u_a", userName: "Alice" }, 2: { userId: "u_b", userName: "Bob" } });
    const links = friendshipCp.getSeatRelationshipLinks(room);
    assert(links.length === 1 && links[0].type === "cp", "TEST 1: CP users in adjacent seats (1,2) => CP heart link present");
  }
  {
    const room = makeRoom("room1", { 1: { userId: "u_a", userName: "Alice" }, 3: { userId: "u_b", userName: "Bob" } });
    const links = friendshipCp.getSeatRelationshipLinks(room);
    assert(links.length === 0, "TEST 2: CP users in non-adjacent seats (1,3) => no link");
  }

  console.log("=== TEST 3/4: seat changes recalculate immediately ===");
  {
    const room = makeRoom("room1", { 1: { userId: "u_a", userName: "Alice" }, 2: { userId: "u_b", userName: "Bob" } });
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 1, "adjacent => link present before move");
    room.seats[1] = null; // Bob leaves seat 2
    room.seats[3] = { userId: "u_b", userName: "Bob" }; // Bob sits at seat 4 (not adjacent to seat 1)
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 0, "TEST 3: move to non-adjacent seat => heart disappears immediately (recomputed fresh each call)");
    room.seats[3] = null;
    room.seats[1] = { userId: "u_b", userName: "Bob" }; // Bob returns to seat 2
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 1, "TEST 4: move back to adjacent seat => heart reappears immediately");
  }

  console.log("=== Row-wrap corner case via the real getSeatRelationshipLinks path ===");
  {
    const room = makeRoom("room1", { 4: { userId: "u_a", userName: "Alice" }, 5: { userId: "u_b", userName: "Bob" } });
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 0, "seat 4 + seat 5 (row-wrap, diagonal corners) => no link, even though |4-5|===1");
  }

  console.log("=== TEST 7: user leaves room => heart disappears ===");
  {
    const room = makeRoom("room1", { 1: { userId: "u_a", userName: "Alice" }, 2: { userId: "u_b", userName: "Bob" } });
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 1, "adjacent => link present");
    room.seats[1] = null; // Bob leaves entirely (no seat)
    assert(friendshipCp.getSeatRelationshipLinks(room).length === 0, "TEST 7: one user leaves room/unseats => heart disappears");
  }

  console.log("=== Friendship follows the same adjacency rule (independent of CP) ===");
  {
    // fresh pair for friendship so it doesn't collide with the existing CP relationship above
    users["3333333333"] = { userId: "u_c", user: { userId: "u_c", name: "Cara", coins: 10_000_000 } };
    const send = await friendshipCp.sendRequest("u_a", "u_c", "friendship");
    assert(send.success, "friendship request sends");
    const respond = await friendshipCp.respondRequest("u_c", send.request.requestId, "accept");
    assert(respond.success, "friendship request accepted");
    const room = makeRoom("room2", { 1: { userId: "u_a", userName: "Alice" }, 2: { userId: "u_c", userName: "Cara" } });
    let links = friendshipCp.getSeatRelationshipLinks(room);
    assert(links.length === 1 && links[0].type === "friendship", "TEST 5: Friendship users in adjacent seats => Friendship heart visible");
    room.seats[1] = null;
    room.seats[5] = { userId: "u_c", userName: "Cara" }; // seat 6, not adjacent to seat 1
    links = friendshipCp.getSeatRelationshipLinks(room);
    assert(links.length === 0, "TEST 6: Friendship users in non-adjacent seats => Friendship heart invisible");
  }

  console.log("=== TEST 13: existing relationship request/accept flow unaffected ===");
  {
    // Duplicate request while one already exists should be rejected — proves business rules untouched.
    const dup = await friendshipCp.sendRequest("u_a", "u_b", "cp");
    assert(dup.success === false, "TEST 13: sending a request when a relationship already exists is still correctly rejected");
  }

  console.log("=== Admin visual config: defaults, save, live broadcast, cache-bust version ===");
  {
    const getRes = callRoute("GET", "/api/admin/relationships/config", {});
    assert(getRes._status === 200 && getRes._body.success, "admin GET config succeeds");
    assert(getRes._body.config.cp.width === 126, "CP default width is 126 (matches prior hardcoded CSS value, now config-driven)");
    assert(getRes._body.config.friendship.width === 104, "Friendship default width is 104");
    assert(getRes._body.resolved.cp.assetUrl.includes("cp-heart.png"), "resolved config points at the default bundled CP asset when no custom asset is enabled");

    const versionBefore = getRes._body.config.version;
    const saveRes = callRoute("POST", "/api/admin/relationships/config/cp", { params: { type: "cp" }, body: { width: 60, height: 60, opacity: 0.5 } });
    assert(saveRes._status === 200 && saveRes._body.success, "TEST 9: admin can save a new CP size (40px->60px style change)");
    assert(saveRes._body.config.cp.width === 60 && saveRes._body.config.cp.height === 60, "TEST 9: saved config reflects the new 60px size");
    assert(saveRes._body.config.version === versionBefore + 1, "CACHE-BUST: version increments on every config save");
    assert(emittedIo.some((e) => e.event === "relationship-config-update"), "TEST 9: relationship-config-update broadcast fired so connected clients update live without refresh");

    // TEST 10 (persistence across restart): re-initialize the module against
    // the same diskStore/safeRead mock, simulating a server restart that
    // re-reads relationship_visual_config.json from disk.
    const restarted = initFriendshipCp({
      app: { get() {}, post() {} }, DATA_FOLDER, safeRead, safeWrite,
      findUserByUserId, saveUsers, clampCoinBalance, logTransaction,
      users, userAuth, io: { to() { return { emit() {} }; }, emit() {} },
      pushWalletUpdate, emitToUser, privateMessages, saveMessages, conversationKey,
      getRooms
    });
    const persisted = restarted.publicVisualConfig();
    assert(persisted.cp.width === 60, "TEST 10: CP size setting survives a simulated server restart (re-read from disk)");
  }

  console.log("=== Admin visual config: reset restores defaults but preserves custom-asset flag ===");
  {
    callRoute("POST", "/api/admin/relationships/config/cp", { params: { type: "cp" }, body: { customAssetEnabled: true } });
    const resetRes = callRoute("POST", "/api/admin/relationships/config/cp/reset", { params: { type: "cp" }, body: {} });
    assert(resetRes._body.config.cp.width === 126, "reset restores default width");
    assert(resetRes._body.config.cp.customAssetEnabled === true, "reset does not clobber the custom-asset-enabled flag (spec: reset is size/opacity/animation/position only)");
  }

  console.log("=== TEST 11: admin uploads a new PNG => cache-busted URL changes ===");
  {
    const before = callRoute("GET", "/api/admin/relationships/config", {})._body.resolved.friendship.assetUrl;
    const uploadRes = callRoute("POST", "/api/admin/relationships/asset/friendship", { params: { type: "friendship" }, _fakeFile: "new-heart.png" });
    assert(uploadRes._status === 200 && uploadRes._body.success, "upload PNG succeeds");
    // Not enabled yet -> resolved URL still points at bundled default, but version still bumped (cache-bust applies globally).
    const afterUploadNotEnabled = uploadRes._body.resolved.friendship.assetUrl;
    assert(afterUploadNotEnabled !== before, "TEST 11: version query string changes after upload even before enabling, so no stale cache anywhere");
    const enableRes = callRoute("POST", "/api/admin/relationships/config/friendship", { params: { type: "friendship" }, body: { customAssetEnabled: true } });
    assert(enableRes._body.resolved.friendship.assetUrl.includes("/relationship-assets/"), "TEST 11: once enabled, the resolved asset URL points at the uploaded custom asset");
  }

  console.log("=== Input clamping: nonsense admin input can't corrupt config ===");
  {
    const r = callRoute("POST", "/api/admin/relationships/config/cp", { params: { type: "cp" }, body: { width: 99999, opacity: 5, scale: -3 } });
    assert(r._body.config.cp.width === 400, "width is clamped to the documented max (400px)");
    assert(r._body.config.cp.opacity === 1, "opacity is clamped to max 1");
    assert(r._body.config.cp.scale === 0.1, "scale is clamped to min 0.1 (never negative/zero)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
