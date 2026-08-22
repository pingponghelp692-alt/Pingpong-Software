// test/redisAuthoritativeState.test.js
// Gap #1 (Redis Authoritative Runtime State) — verifies the cross-instance
// session read-through added to security/userAuth.js. No real Redis is
// available in this environment (see FINAL_INTEGRATION_REPORT.md §14), so
// this test injects a small in-memory fake in place of redis/client.js and
// redis/sessionStore.js via the require cache — same spirit as the
// project's existing test/mockPg.js for Postgres. It exercises the actual
// userAuth.js module, not a re-implementation.
//
// Run: node test/redisAuthoritativeState.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---------- Fake Redis layer ----------
// Mimics just enough of redis/client.js + redis/sessionStore.js's shape
// for userAuth.js's validateTokenCrossInstance() to exercise its real
// logic against. A separate "remote" Map stands in for "a session created
// by a DIFFERENT process/instance" — exactly the case this gap closes.
const remoteSessions = new Map(); // token -> { userId, createdAt, lastSeenAt }
let redisEnabled = true;

const fakeClient = {
  isEnabled: () => redisEnabled,
};
const fakeSessionStore = {
  validateSession: async (token) => {
    if (!redisEnabled) return null;
    return remoteSessions.get(token) || null;
  },
  touchSession: async () => true,
  createSession: async () => true,
  revokeSession: async () => true,
  revokeAllSessions: async () => 0,
};

const clientPath = require.resolve(path.join(__dirname, "..", "redis", "client.js"));
const sessionStorePath = require.resolve(path.join(__dirname, "..", "redis", "sessionStore.js"));
const userAuthPath = require.resolve(path.join(__dirname, "..", "security", "userAuth.js"));

// Register the fakes in the require cache BEFORE userAuth.js is first
// required, so its module-level `require(...)` calls resolve to these
// instead of the real files (which would otherwise no-op with Redis
// disabled, since ioredis isn't installed in this sandbox).
require.cache[clientPath] = new Module(clientPath, null);
require.cache[clientPath].exports = fakeClient;
require.cache[sessionStorePath] = new Module(sessionStorePath, null);
require.cache[sessionStorePath].exports = fakeSessionStore;
delete require.cache[userAuthPath]; // ensure a fresh load picks up the fakes above

const userAuth = require(userAuthPath);

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

console.log("=== validateTokenCrossInstance: local hit short-circuits (no Redis call) ===");
{
  const token = userAuth.issueToken("7000000001");
  userAuth.validateTokenCrossInstance(token).then((mobile) => {
    assert(mobile === "7000000001", "local hit resolves to the right mobile");
  });
}

console.log("=== validateTokenCrossInstance: local miss + Redis hit hydrates local cache ===");
{
  const remoteToken = "remote-session-token-abc123";
  remoteSessions.set(remoteToken, {
    userId: "7000000002",
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  userAuth.validateTokenCrossInstance(remoteToken).then((mobile) => {
    assert(mobile === "7000000002", "cross-instance session resolved via the Redis fallback");
    // Second call should now hit the LOCAL fast path (hydrated), not Redis.
    const secondCallMobile = userAuth.validateToken(remoteToken);
    assert(secondCallMobile === "7000000002", "local Maps were hydrated — subsequent calls are local hits");
    userAuth.revokeToken(remoteToken);
  });
}

console.log("=== validateTokenCrossInstance: token unknown everywhere returns null ===");
{
  userAuth.validateTokenCrossInstance("totally-unknown-token").then((mobile) => {
    assert(mobile === null, "unknown token resolves to null, not an error");
  });
}

console.log("=== requireUserAuth: cross-instance token is accepted (async path) ===");
{
  const remoteToken = "remote-session-token-xyz789";
  remoteSessions.set(remoteToken, {
    userId: "7000000003",
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const req = { headers: { authorization: "Bearer " + remoteToken }, body: {}, query: {}, method: "GET", path: "/api/test" };
  const res = mockRes();
  new Promise((resolve) => {
    userAuth.requireUserAuth(req, res, () => resolve("next-called"));
    // requireUserAuth resolves this asynchronously for the cross-instance
    // path — give the microtask queue a turn.
    setTimeout(() => resolve("timed-out"), 200);
  }).then((outcome) => {
    assert(outcome === "next-called", "next() was eventually called for a valid cross-instance token");
    assert(req.authedMobile === "7000000003", "req.authedMobile resolved to the cross-instance session's real owner");
  });
}

console.log("=== requireUserAuth: Redis disabled still rejects synchronously (unchanged behavior) ===");
{
  redisEnabled = false;
  const req = { headers: { authorization: "Bearer some-unknown-token" }, body: {}, query: {}, method: "GET", path: "/api/test" };
  const res = mockRes();
  let nextCalled = false;
  userAuth.requireUserAuth(req, res, () => { nextCalled = true; });
  assert(!nextCalled, "next() was NOT called synchronously");
  assert(res.statusCode === 401, "responds 401 synchronously when Redis is disabled — no behavior change from pre-Gap#1");
  redisEnabled = true;
}

// Give all pending .then() chains above a chance to run before reporting,
// since several assertions above are inside async callbacks.
setTimeout(() => {
  console.log("\n==================================================");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("==================================================");
  process.exit(fail === 0 ? 0 : 1);
}, 300);
