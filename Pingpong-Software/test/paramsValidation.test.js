// test/paramsValidation.test.js
// Verifies security/validation.js's isSafeObjectKey() — the real function,
// not a re-implementation — added in Module 5.2 to guard route :roomId /
// :groupId params before they're used as a direct bracket-notation lookup
// into a plain in-memory object store (rooms[...], groupsStore[...]).
//
// HONEST LIMITATION: server.js's safeRoomLookup()/safeGroupLookup() wrap
// this function around the actual `rooms`/`groupsStore` objects, but
// server.js can't be require()'d standalone in this sandbox (needs
// express/socket.io/etc. actually installed; no network egress here to
// npm install them — same limitation as every other server.js-dependent
// test in this suite). What's verified here for real is the exact guard
// function those two wrappers call, with the exact behavior that matters:
// a store lookup keyed by a dangerous prototype-chain property name must
// be treated as "not found", not resolve to a real object.
//
// Run: node test/paramsValidation.test.js

const path = require("path");
const { isSafeObjectKey } = require(path.join(__dirname, "..", "security", "validation.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// Mirrors server.js's safeRoomLookup()/safeGroupLookup() exactly, against
// a real plain object store, to prove the end-to-end behavior (not just
// the guard function in isolation).
function safeLookup(store, key) {
  return isSafeObjectKey(key) ? store[key] : undefined;
}

console.log("=== isSafeObjectKey: legitimate IDs ===");
{
  assert(isSafeObjectKey("room_ab12cd34") === true, "a normal generated roomId is accepted");
  assert(isSafeObjectKey("grp_9f8e7d6c") === true, "a normal generated groupId is accepted");
  assert(isSafeObjectKey("1") === true, "a short numeric-looking id is accepted");
}

console.log("=== isSafeObjectKey: dangerous prototype-chain keys are rejected ===");
{
  assert(isSafeObjectKey("__proto__") === false, "__proto__ is rejected");
  assert(isSafeObjectKey("constructor") === false, "constructor is rejected");
  assert(isSafeObjectKey("prototype") === false, "prototype is rejected");
}

console.log("=== isSafeObjectKey: type/shape guards ===");
{
  assert(isSafeObjectKey(undefined) === false, "undefined (param missing entirely) is rejected");
  assert(isSafeObjectKey(null) === false, "null is rejected");
  assert(isSafeObjectKey("") === false, "empty string is rejected");
  assert(isSafeObjectKey(123) === false, "a non-string value is rejected");
  assert(isSafeObjectKey(["a"]) === false, "an array (e.g. ?roomId=a&roomId=b parsed to an array) is rejected");
  assert(isSafeObjectKey("x".repeat(129)) === false, "an over-length id (129 chars) is rejected");
  assert(isSafeObjectKey("x".repeat(128)) === true, "an id right at the length cap (128 chars) is accepted");
}

console.log("=== End-to-end: real object store lookup behavior ===");
{
  const rooms = { "room-1": { roomId: "room-1", hostId: "u1" } };
  assert(safeLookup(rooms, "room-1") !== undefined, "a real, existing room is still found normally");
  assert(safeLookup(rooms, "room-2") === undefined, "a made-up but well-formed roomId correctly resolves to undefined");

  // The actual bug this closes: without the guard, `rooms["__proto__"]`
  // resolves to Object.prototype — a real, truthy object — so a route's
  // `if (!room) return "not found"` check would NOT catch it.
  const bareLookup = rooms["__proto__"];
  assert(!!bareLookup === true, "confirms the underlying JS behavior this guards against: bare bracket lookup on '__proto__' IS truthy");
  assert(safeLookup(rooms, "__proto__") === undefined, "the guarded lookup correctly treats '__proto__' as not-found instead");
  assert(safeLookup(rooms, "constructor") === undefined, "the guarded lookup correctly treats 'constructor' as not-found instead");
}

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
