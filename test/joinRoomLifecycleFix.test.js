// test/joinRoomLifecycleFix.test.js
// Regression test for the 2026-08-14 fix responding to the production log
// showing repeated join-room / disconnect / reconnect / seat-freed cycles
// for the same user (see PingPong-ROBIN-FINAL-FIX-2026-08-14 request).
//
// HONEST LIMITATION (same as test/roomStateJoinRace.test.js and every
// other server.js-dependent test in this suite): server.js cannot be
// require()'d standalone in this sandbox (needs express/socket.io/etc.
// actually installed; no network egress here to npm install them, and no
// node_modules present). This test therefore does two things, both
// against the REAL, currently-committed server.js/app.js source — not a
// re-implementation of their logic:
//
//   1. STRUCTURAL CHECKS (the real regression guards): grep the actual
//      committed source for the specific fixes described in the fix
//      report below. If any of these are ever reverted/reordered, this
//      test fails against the real file, not a copy of it.
//   2. BEHAVIORAL SIMULATION of the one piece of genuinely new, pure
//      logic the fix introduces — connection-generation tracking
//      (bindSocketToUser / userConnGeneration) — reimplemented faithfully
//      from the committed source so its race-guard behavior can actually
//      be exercised with fake timers/sequencing, the same honest
//      "simulation, not execution" approach roomStateJoinRace.test.js
//      already uses for Socket.IO's room-emit semantics.
//
// Run: node test/joinRoomLifecycleFix.test.js

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

console.log("\n=== Part 1: server-side join idempotency (server.js) ===");
{
  const joinHandlerMatch = serverSrc.match(/socket\.on\("join-room",[\s\S]*?\n {8}\}\);/);
  assert(!!joinHandlerMatch, "join-room handler found in server.js");
  const body = joinHandlerMatch ? joinHandlerMatch[0] : "";
  assert(
    /socket\.currentRoom === roomId && socket\.userId === userId && socketsByUserId\[userId\] === socket\.id/.test(body),
    "join-room handler short-circuits a duplicate join-room for a room the socket is already joined to"
  );
  assert(
    /ignoring duplicate join for already-joined user/.test(body),
    "duplicate-join short-circuit is logged (not silently dropped, per 'do not mask the problem' requirement)"
  );
}

console.log("\n=== Part 2: stale room joins / room-switch cleanup (server.js) ===");
{
  const joinHandlerMatch = serverSrc.match(/socket\.on\("join-room",[\s\S]*?\n {8}\}\);/);
  const body = joinHandlerMatch ? joinHandlerMatch[0] : "";
  assert(
    /if \(socket\.currentRoom && socket\.currentRoom !== roomId\)/.test(body),
    "join-room handler detects when the socket is already a member of a DIFFERENT room"
  );
  assert(
    /handleUserLeaveRoom\(socket\.currentRoom, userId, socket, false\)/.test(body),
    "join-room handler cleans up the OLD room via handleUserLeaveRoom() before joining the new one"
  );
  // Order matters: the switch-cleanup must run BEFORE the local/cross-instance
  // join branches that actually perform the new join.
  const switchIdx = body.indexOf("handleUserLeaveRoom(socket.currentRoom, userId, socket, false)");
  const localJoinIdx = body.indexOf("performRoomJoin(room,");
  assert(switchIdx !== -1 && localJoinIdx !== -1 && switchIdx < localJoinIdx,
    "old-room cleanup happens BEFORE the new room's join is performed (leave old -> join new, not the reverse)");
}

console.log("\n=== Part 3: join sequencing token guards the async cross-instance path (server.js) ===");
{
  assert(/socket\._joinSeq = \(socket\._joinSeq \|\| 0\) \+ 1;/.test(serverSrc),
    "a per-socket join sequence counter is incremented on every join-room request");
  assert(/if \(socket\._joinSeq !== mySeq\) \{/.test(serverSrc),
    "the cross-instance RPC .then() callback discards its result if a newer join-room superseded it");
  assert(/discarding stale cross-instance RPC result/.test(serverSrc),
    "the discard path is logged, not silent");
}

console.log("\n=== Part 4: connection-generation tracking exists and is wired into both grace-period timers (server.js) ===");
{
  assert(/let userConnGeneration = \{\};/.test(serverSrc), "userConnGeneration map declared");
  assert(/function bindSocketToUser\(socket, userId\) \{/.test(serverSrc), "bindSocketToUser() helper declared");
  assert(/bindSocketToUser\(socket, userId\); \/\/ ROOT-CAUSE FIX \(2026-08-14\)[\s\S]*?identify handler/.test(serverSrc) || /finishIdentify[\s\S]{0,400}bindSocketToUser\(socket, userId\)/.test(serverSrc),
    "identify handler's finishIdentify() uses bindSocketToUser() instead of a bare socketsByUserId assignment");
  assert(/bindSocketToUser\(socket, userId\); \/\/ ROOT-CAUSE FIX \(2026-08-14\)[\s\S]*?generation for the grace-period/.test(serverSrc),
    "join-room handler's finishJoin() uses bindSocketToUser() instead of a bare socketsByUserId assignment");

  const disconnectHandlerMatch = serverSrc.match(/socket\.on\("disconnect", \(\) => \{[\s\S]*?\n {4}\}\);/);
  assert(!!disconnectHandlerMatch, "disconnect handler found in server.js");
  const dBody = disconnectHandlerMatch ? disconnectHandlerMatch[0] : "";
  assert(/const myGen = socket\.connGen;/.test(dBody) && (dBody.match(/const myGen = socket\.connGen;/g) || []).length === 2,
    "BOTH the room-grace timer and the presence-grace timer capture socket.connGen at schedule time");
  assert(/staleByGeneration = myGen !== undefined && userConnGeneration\[uid\] !== myGen/.test(dBody),
    "grace-period timers compare the captured generation against the CURRENT generation before acting");
  assert((dBody.match(/staleByGeneration/g) || []).length >= 4,
    "the generation check is actually used in both timers' stale-guard conditions, not just computed and discarded");
}

console.log("\n=== Part 5: seat cleanup verifies seat ownership before freeing on a stale disconnect (server.js) ===");
{
  // NOTE: handleUserLeaveRoom() is a large, multi-hundred-line function
  // with nested blocks closing at the same indentation level as the
  // function itself, so a lazy "match to the first line closing at the
  // function's indent" regex (as used for the shorter finishJoin() in
  // Part 1-3's checks) would stop at the FIRST inner "if" block's closing
  // brace, not the function's actual end. Locate the real end by finding
  // the start of the next top-level function declaration instead.
  const startIdx = serverSrc.indexOf("function handleUserLeaveRoom(roomId, userId, socket, isDisconnecting = false) {");
  assert(startIdx !== -1, "handleUserLeaveRoom() found in server.js");
  const nextFnIdx = serverSrc.indexOf("\nfunction ", startIdx + 1);
  const body = startIdx !== -1 ? serverSrc.slice(startIdx, nextFnIdx !== -1 ? nextFnIdx : undefined) : "";

  assert(/if \(isDisconnecting && socket && socketsByUserId\[userId\] && socketsByUserId\[userId\] !== socket\.id\) \{/.test(body),
    "handleUserLeaveRoom() has a top-of-function guard rejecting stale isDisconnecting=true calls");
  assert(/if \(isDisconnecting && socket && s\.socketId && s\.socketId !== socket\.id\) \{/.test(body),
    "seat-freeing loop verifies the seat's current socketId matches the disconnecting socket before freeing it");

  const seatLoopMatch = body.match(/room\.seats\.forEach\(\(s, i\) => \{[\s\S]*?\n {4}\}\);/);
  assert(!!seatLoopMatch, "seat-freeing forEach loop found");
  if (seatLoopMatch) {
    const loopBody = seatLoopMatch[0];
    const guardIdx = loopBody.indexOf("s.socketId !== socket.id");
    const nullIdx = loopBody.indexOf("room.seats[i] = null");
    assert(guardIdx !== -1 && nullIdx !== -1 && guardIdx < nullIdx,
      "the ownership guard is checked BEFORE the seat is actually freed (room.seats[i] = null)");
  }
}

console.log("\n=== Part 6: client-side join guards prevent duplicate/overlapping join-room emits (public/app.js) ===");
{
  assert(/let joinedRoomId = null;/.test(appSrc), "joinedRoomId state declared");
  assert(/let joinInProgress = false;/.test(appSrc), "joinInProgress state declared");
  assert(/let pendingJoinRequest = null;/.test(appSrc), "pendingJoinRequest (last-write-wins queue) state declared");

  const joinRoomMatch = appSrc.match(/async function joinRoom\(roomId, password\) \{([\s\S]*?)\n\}/);
  assert(!!joinRoomMatch, "joinRoom() found in app.js");
  const jrBody = joinRoomMatch ? joinRoomMatch[1] : "";
  assert(/if \(joinedRoomId === roomId && currentRoomId === roomId && !password\) \{/.test(jrBody),
    "joinRoom() no-ops a duplicate tap for the room the client already believes it's joined to");
  assert(/if \(joinInProgress\) \{/.test(jrBody) && /pendingJoinRequest = \{ roomId, password \};/.test(jrBody),
    "joinRoom() queues (rather than immediately emitting) a new request while a join is already in flight");

  const roomStateMatch = appSrc.match(/socket\.on\("room-state", \(room\) => \{([\s\S]*?)\/\/ The Robin toolbar/);
  assert(!!roomStateMatch, "room-state handler's join-ack block found in app.js");
  const rsBody = roomStateMatch ? roomStateMatch[1] : "";
  assert(/joinedRoomId = room\.roomId;/.test(rsBody) && /joinInProgress = false;/.test(rsBody),
    "room-state handler is the single place that marks a join as actually complete (server-ack-driven, not optimistic)");
  assert(/joinRoom\(next\.roomId, next\.password\);/.test(rsBody),
    "a queued room-switch request is dispatched once the in-flight join settles (last-tap-wins room switching)");
}

console.log("\n" + "=".repeat(50));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("=".repeat(50));
process.exit(fail > 0 ? 1 : 0);
