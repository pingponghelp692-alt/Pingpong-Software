// test/authHardening.test.js
// Verifies security/userAuth.js's requireUserAuth — the real middleware
// now gating the endpoints hardened in Module 5.1 (groups, room/create,
// follow/unfollow, profile/photo, uploads). Runs the actual module, not a
// re-implementation, with mock req/res objects.
//
// Run: node test/authHardening.test.js

const path = require("path");
const userAuth = require(path.join(__dirname, "..", "security", "userAuth.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

console.log("=== requireUserAuth: no token at all ===");
{
  const req = { headers: {}, body: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;
  userAuth.requireUserAuth(req, res, () => { nextCalled = true; });
  assert(!nextCalled, "next() was NOT called with no token");
  assert(res.statusCode === 401, "responds 401 with no token");
  assert(res.body && res.body.forceLogout === true, "forceLogout flag set");
}

console.log("=== requireUserAuth: garbage/forged token ===");
{
  const req = { headers: { authorization: "Bearer not-a-real-token" }, body: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;
  userAuth.requireUserAuth(req, res, () => { nextCalled = true; });
  assert(!nextCalled, "next() was NOT called with a forged token");
  assert(res.statusCode === 401, "responds 401 with a forged token");
}

console.log("=== requireUserAuth: real issued token ===");
{
  const token = userAuth.issueToken("9999999999");
  const req = { headers: { authorization: "Bearer " + token }, body: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;
  userAuth.requireUserAuth(req, res, () => { nextCalled = true; });
  assert(nextCalled, "next() WAS called with a real, valid token");
  assert(req.authedMobile === "9999999999", "req.authedMobile set to the token's real owner, not anything client-supplied");
  userAuth.revokeToken(token);
}

console.log("=== requireUserAuth: someone else's real token can't be used to claim a different identity ===");
{
  // This is exactly the class of attack the Module 5.1 endpoint fixes close:
  // previously req.body.userId/mobile was trusted directly. Now every
  // hardened endpoint derives identity from req.authedMobile (set here),
  // never from the body — so even a valid token only ever resolves to its
  // OWN owner, no matter what identity the request body claims.
  const token = userAuth.issueToken("1111111111");
  const req = {
    headers: { authorization: "Bearer " + token },
    body: { mobile: "2222222222", userId: "attacker-claims-this-userid" }, // forged identity in the body
    query: {}
  };
  const res = mockRes();
  userAuth.requireUserAuth(req, res, () => {});
  assert(req.authedMobile === "1111111111", "authedMobile reflects the TOKEN's real owner, ignoring the forged body fields entirely");
  userAuth.revokeToken(token);
}

console.log("=== requireUserAuth: revoked token is rejected ===");
{
  const token = userAuth.issueToken("3333333333");
  userAuth.revokeToken(token);
  const req = { headers: { authorization: "Bearer " + token }, body: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;
  userAuth.requireUserAuth(req, res, () => { nextCalled = true; });
  assert(!nextCalled, "revoked token is rejected");
  assert(res.statusCode === 401, "responds 401 for a revoked token");
}

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
