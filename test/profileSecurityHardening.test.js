// test/profileSecurityHardening.test.js
// Static regression guard for the profile/ownership hardening pass.
// This intentionally checks the real server/module source so future edits
// cannot silently remove the security boundaries without the test suite
// noticing.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const vehicles = fs.readFileSync(path.join(root, "vehicles.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("=== Profile authentication boundaries ===");
assert(
  server.includes('app.post("/api/user/check-username", userAuth.requireUserAuth'),
  "username availability is authenticated"
);
assert(
  server.includes('app.post("/api/user/complete-profile", userAuth.requireUserAuth, authLimiter'),
  "complete-profile is authenticated"
);
assert(
  server.includes('app.get("/api/user/:mobile", userAuth.requireUserAuth'),
  "own-profile lookup is authenticated"
);
assert(
  server.includes('app.get("/api/user/:mobile/following", userAuth.requireUserAuth'),
  "following list is authenticated"
);
assert(
  server.includes('app.get("/api/user/:mobile/followers", userAuth.requireUserAuth'),
  "followers list is authenticated"
);

console.log("=== Token-derived ownership ===");
assert(
  server.includes('const mobile = req.authedMobile;') &&
  server.includes('req.params.mobile !== mobile'),
  "own-profile route rejects a different client-supplied mobile"
);
assert(
  server.includes('const actor = users[req.authedMobile];') &&
  server.includes('actor.userId !== req.params.userId'),
  "frame inventory is bound to the authenticated user"
);
assert(
  server.includes('const { frameId } = req.body;') &&
  server.includes('const userId = actor.userId;'),
  "frame activation ignores a client-supplied userId"
);

console.log("=== Credential exposure protection ===");
assert(
  server.includes('function publicUserView(user)') &&
  server.includes('delete copy.passwordHash') &&
  server.includes('delete copy.password'),
  "user responses pass through a credential-stripping projection"
);
assert(
  !server.includes('res.json({ success: true, user: users[mobile], authToken });'),
  "login responses no longer serialize the raw user object"
);
assert(
  !server.includes('res.json({ success: true, user: { ...user, passwordHash: undefined }, authToken });'),
  "password-login response uses the central safe-user projection"
);

console.log("=== Password setup protection ===");
assert(
  server.includes('app.post("/api/auth/set-password", userAuth.requireUserAuth, authLimiter'),
  "password setup requires an authenticated session"
);
assert(
  server.includes('if (!mobile || !users[mobile]) return res.status(401)'),
  "password setup cannot create an account from an arbitrary phone number"
);
assert(
  server.includes('String(password).length < 8'),
  "new passwords require at least 8 characters"
);

console.log("=== Production admin protection ===");
assert(
  server.includes('const IS_PRODUCTION = process.env.NODE_ENV === "production";'),
  "production mode is explicitly detected"
);
assert(
  server.includes('Refusing to start with insecure admin defaults'),
  "production refuses missing admin credentials"
);
assert(
  server.includes('password intentionally not logged'),
  "admin password is not printed at startup"
);



console.log("=== Other private account surfaces ===");
for (const route of [
  'app.get("/api/recent-rooms/:userId", userAuth.requireUserAuth',
  'app.delete("/api/recent-rooms/:userId", userAuth.requireUserAuth',
  'app.get("/api/following-live/:userId", userAuth.requireUserAuth',
  'app.get("/api/my-groups/:userId", userAuth.requireUserAuth',
  'app.get("/api/agency/mine/:userId", userAuth.requireUserAuth',
  'app.get("/api/messages/inbox/:userId", userAuth.requireUserAuth',
  'app.get("/api/messages/thread/:userId1/:userId2", userAuth.requireUserAuth',
  'app.post("/api/messages/send", userAuth.requireUserAuth',
  'app.get("/api/coin-center/mine/:userId", userAuth.requireUserAuth',
  'app.get("/api/coin-center/log/:userId", userAuth.requireUserAuth'
]) {
  assert(server.includes(route), route.replace('app.', '').split(',')[0] + " is authenticated");
}
assert(
  server.includes('const fromUserId = actor.userId;') &&
  !server.includes('const { fromUserId, toUserId, message } = req.body;'),
  "private-message sender identity comes from the authenticated session"
);

console.log("=== Vehicle ownership protection ===");
assert(
  vehicles.includes('app.get("/api/vehicles/mine/:userId", userAuth.requireUserAuth'),
  "vehicle inventory requires authentication"
);
assert(
  vehicles.includes('app.post("/api/vehicles/use", userAuth.requireUserAuth'),
  "vehicle activation requires authentication"
);
assert(
  vehicles.includes('app.post("/api/vehicles/deactivate", userAuth.requireUserAuth'),
  "vehicle deactivation requires authentication"
);
assert(
  vehicles.includes('const userId = actor.userId;'),
  "vehicle mutations derive userId from the authenticated actor"
);



console.log("=== Private call infrastructure ===");
const callSignaling = fs.readFileSync(path.join(root, "callSignaling.js"), "utf8");
assert(
  callSignaling.includes('app.get("/api/calls/ice-servers", requireUserAuth'),
  "ICE/TURN credential endpoint requires authentication"
);
assert(
  callSignaling.includes('app.get("/api/calls/history/:userId1/:userId2", requireUserAuth'),
  "call history requires authentication"
);
assert(
  callSignaling.includes('You can only view your own call history'),
  "call history rejects third-party conversations"
);

console.log("=== Frontend identity hardening ===");
assert(
  app.includes('api("/api/frames/use", "POST", { frameId: useBtn.dataset.id })'),
  "frontend no longer sends a client-controlled frame owner id"
);
assert(
  app.includes('api("/api/frames/deactivate", "POST", {})'),
  "frontend no longer sends a client-controlled frame owner id on deactivate"
);

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
