// test/roomStateJoinRace.test.js
// Regression test for BUG-001 (forensic audit, 2026-08-10): a freshly
// joining socket never received its own initial "room-state" broadcast,
// because performRoomJoin() (local path) — and the owning instance's own
// performRoomJoin() on the cross-instance path — emit io.to(roomId).emit
// ("room-state", ...) BEFORE this socket has executed socket.join(roomId)
// inside finishJoin(). Socket.IO room-scoped emits only reach sockets
// that are ALREADY members of that room, so the joining socket silently
// missed it.
//
// HONEST LIMITATION (same as every other server.js-dependent test in this
// suite — see e.g. paramsValidation.test.js's own header): server.js
// cannot be require()'d standalone in this sandbox (needs express/
// socket.io actually installed; no network egress here to npm install
// them, and no node_modules present). This test therefore does two
// things, both against the REAL, currently-committed server.js source —
// not a re-implementation of its logic:
//
//   1. STRUCTURAL CHECK (the real regression guard): parses the actual
//      finishJoin() function body out of server.js and asserts that
//      socket.emit("room-state", roomSnapshot) appears AFTER
//      socket.join(roomId) within it. If someone ever reorders these two
//      lines back, or removes the fix, this test fails — it is reading
//      the real source, not a copy of it.
//   2. BEHAVIORAL SIMULATION: a minimal, faithful re-implementation of
//      Socket.IO's actual room-emit semantics (io.to(room).emit(...)
//      only reaches sockets currently in that room's membership set) is
//      used to demonstrate WHY the ordering matters and that the fixed
//      ordering (join, then emit) actually delivers the event while the
//      old ordering (emit, then join) does not. This part is clearly a
//      simulation of Socket.IO semantics, not an exercise of server.js
//      itself — flagged as such, not hidden.
//
// Run: node test/roomStateJoinRace.test.js

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("\n=== Part 1: structural check against the real server.js source ===");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Extract the finishJoin(roomSnapshot) function body specifically (not
// just a global grep) so this test fails loudly if finishJoin is ever
// renamed/restructured rather than silently passing on an unrelated match
// elsewhere in this 6,600+ line file.
const fnMatch = serverSrc.match(/function finishJoin\(roomSnapshot\) \{([\s\S]*?)\n        \}\n/);
assert(!!fnMatch, "finishJoin(roomSnapshot) function found in server.js");

if (fnMatch) {
  const body = fnMatch[1];
  const joinIdx = body.indexOf("socket.join(roomId)");
  const emitIdx = body.indexOf('socket.emit("room-state"');
  assert(joinIdx !== -1, "finishJoin() calls socket.join(roomId)");
  assert(emitIdx !== -1, "finishJoin() sends room-state directly to the joining socket (BUG-001 fix present)");
  assert(joinIdx !== -1 && emitIdx !== -1 && emitIdx > joinIdx,
    "socket.emit(\"room-state\", ...) occurs AFTER socket.join(roomId) — the joining socket is a room member before this fires");
  // Guard against the fix being wired to a stale/wrong payload variable.
  assert(/socket\.emit\("room-state",\s*roomSnapshot\)/.test(body),
    "the direct emit uses the same, already-current roomSnapshot finishJoin() received (not a stale/re-derived value)");
}

console.log("\n=== Part 2: behavioral simulation of Socket.IO room-emit semantics ===");
console.log("(Illustrates WHY the fix works — this simulates Socket.IO's real");
console.log(" join/emit contract, it does not execute server.js itself. Full");
console.log(" dynamic proof requires the live-environment test in the docs below.)");

function makeFakeIo() {
  const roomMembers = new Map(); // roomId -> Set(socket)
  return {
    to(roomId) {
      return {
        emit(event, payload) {
          const members = roomMembers.get(roomId) || new Set();
          members.forEach((s) => s.received.push({ event, payload }));
        }
      };
    },
    join(socket, roomId) {
      if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
      roomMembers.get(roomId).add(socket);
    }
  };
}
function makeFakeSocket() { return { received: [] }; }

// OLD (buggy) ordering: emit before join.
{
  const io = makeFakeIo();
  const joiningSocket = makeFakeSocket();
  io.to("room1").emit("room-state", { snapshot: 1 }); // performRoomJoin()'s broadcast, fires first
  io.join(joiningSocket, "room1");                     // finishJoin()'s socket.join(), fires second
  const got = joiningSocket.received.some((m) => m.event === "room-state");
  assert(got === false, "OLD ordering (emit-then-join) reproduces the bug: joining socket receives nothing");
}

// NEW (fixed) ordering: join, then emit directly to the joining socket.
{
  const io = makeFakeIo();
  const joiningSocket = makeFakeSocket();
  io.join(joiningSocket, "room1");                     // socket.join(roomId)
  joiningSocket.received.push({ event: "room-state", payload: { snapshot: 2 } }); // socket.emit(...) — direct, not room-scoped
  const got = joiningSocket.received.some((m) => m.event === "room-state");
  assert(got === true, "NEW ordering (join, then direct socket.emit) delivers room-state to the joining socket");
}

// Already-present users must be unaffected: they were already room
// members before this join, so the existing io.to(roomId).emit(...)
// broadcast (unchanged, still fired by performRoomJoin()) still reaches
// them exactly as before — the fix only adds a second, targeted emit for
// the NEW socket, never removes or alters the room-wide one.
{
  const io = makeFakeIo();
  const alreadyPresent = makeFakeSocket();
  io.join(alreadyPresent, "room1");
  io.to("room1").emit("room-state", { snapshot: 3 }); // unchanged broadcast from performRoomJoin()
  assert(alreadyPresent.received.length === 1 && alreadyPresent.received[0].payload.snapshot === 3,
    "an already-present user still receives the existing room-wide broadcast unchanged (no regression)");
}

console.log("\n=== NOT EXECUTED — REQUIRES LIVE ENVIRONMENT ===");
console.log("The structural check above guards the source-level fix permanently.");
console.log("A full dynamic proof needs a real Socket.IO server + real client(s).");
console.log("Procedure to run manually against a staging/live server:");
console.log("  1. Start the server with a room already containing user A (seated).");
console.log("  2. Connect user B's client, call joinRoom(roomId) — do NOT have B");
console.log("     take any seat, send any message, or trigger any other event.");
console.log("  3. Assert, purely from B's client-side console/network tab, that a");
console.log("     \"room-state\" Socket.IO event arrives within ~1s of emitting");
console.log("     \"join-room\", containing A's seat/user ID and B's own onlineUsers entry,");
console.log("     with zero additional client actions taken.");
console.log("  4. Repeat once with Redis/multi-instance enabled and A/B on different");
console.log("     instances, to cover the cross-instance RPC path.");

console.log("\n" + "=".repeat(50));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("=".repeat(50));
process.exit(fail > 0 ? 1 : 0);
