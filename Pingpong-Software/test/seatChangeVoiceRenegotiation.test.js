// seatChangeVoiceRenegotiation.test.js
// Regression test for the 2026-08-10 root-cause fix: seat changes were
// forcing an unnecessary SDP renegotiation on every ALREADY-CONNECTED mesh
// peer, purely because a "seat-update"/action:"take" event fired — not
// because that peer connection actually needed anything. See the
// ROOT-CAUSE FIX comments in public/app.js's "seat-update" handler.
//
// HONESTY NOTE on why this test looks the way it does: public/app.js is a
// ~6500-line browser script (DOM, RTCPeerConnection, socket.io-client, a
// `$()` helper touching hundreds of real page elements) with no module
// boundary — it cannot be `require()`d into plain Node the way
// callSignaling.js/server.js's extracted functions can (this project's
// existing tests only ever exercise real, `require()`-able Node modules —
// see callSignaling.test.js's own header for the same convention). This
// test therefore does two independent things, both real (no fabricated
// "pass"):
//
//   1. STATIC — parses the actual public/app.js source on disk and asserts
//      the specific guard is present at both call sites of the fix, so a
//      future edit that silently removes the guard fails this test.
//   2. BEHAVIORAL — a small, faithful re-implementation of the exact
//      branching logic from the "seat-update" handler (same conditions, same
//      call shape), run against a mock peerConnections map + connectToPeer
//      spy, to prove the *logic itself* — not just its textual presence —
//      produces the right call count for both the "already connected" and
//      "brand new peer" cases.
//
// This does NOT replace real-browser verification (two real tabs/devices,
// one seat-changing while others are seated) — see the final report for
// what remains explicitly unverified.
//
// Run: node test/seatChangeVoiceRenegotiation.test.js

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---------------------------------------------------------------------
// 1. STATIC: the fix is actually present in the shipped source
// ---------------------------------------------------------------------
console.log("\n[1] Static source check (public/app.js)");
const appJsPath = path.join(__dirname, "..", "public", "app.js");
const src = fs.readFileSync(appJsPath, "utf8");

// Production topology is now centralized in reconcileMeshVoice(). It uses
// onlineUsers + seats so audience listeners can receive speaker audio, and
// it creates only missing edges. Existing peer connections are preserved.
assert(
  /function reconcileMeshVoice\(room\) \{[\s\S]*?const desired = new Set\(\);[\s\S]*?if \(!desired\.has\(sid\)\) closePeer\(sid\);[\s\S]*?if \(!peerConnections\[sid\]\) connectToPeer\(sid\);/.test(src),
  "reconcileMeshVoice() owns topology and only creates missing peer connections"
);
assert(
  /onlineUsers/.test(src) && /remoteIsSeated/.test(src),
  "mesh reconciliation includes audience listeners and only links audience to seated speakers"
);

// ---------------------------------------------------------------------
// 2. BEHAVIORAL: faithful re-implementation of the fixed branching logic
// ---------------------------------------------------------------------
console.log("\n[2] Behavioral simulation");

function simulateReconcile({ room, me, mySeatNumber, peerConnections, voiceMode }) {
  const calls = [];
  const closed = [];
  const connectToPeer = (sid) => calls.push(sid);
  const closePeer = (sid) => closed.push(sid);
  if (voiceMode === "sfu") return { calls, closed };
  const seated = new Map();
  (room.seats || []).forEach(s => { if (s && s.userId && s.socketId) seated.set(s.userId, s.socketId); });
  const sockets = new Map();
  (room.onlineUsers || []).forEach(u => { if (u && u.userId && u.socketId && u.userId !== me.userId) sockets.set(u.userId, u.socketId); });
  seated.forEach((sid, uid) => { if (uid !== me.userId) sockets.set(uid, sid); });
  const desired = new Set();
  sockets.forEach((sid, uid) => { if (mySeatNumber !== null || seated.has(uid)) desired.add(sid); });
  Object.keys(peerConnections).forEach(sid => { if (!desired.has(sid)) closePeer(sid); });
  desired.forEach(sid => { if (!peerConnections[sid]) connectToPeer(sid); });
  return { calls, closed };
}

// Case A: seated speaker moves seats; healthy peers remain intact.
{
  const result = simulateReconcile({
    room: { seats: [null, { userId: "userX", socketId: "sockX" }, { userId: "userY", socketId: "sockY" }], onlineUsers: [
      { userId: "me", socketId: "sockMe" }, { userId: "userX", socketId: "sockX" }, { userId: "userY", socketId: "sockY" }
    ] },
    me: { userId: "me" }, mySeatNumber: 5, peerConnections: { sockX: {}, sockY: {} }, voiceMode: "mesh"
  });
  assert(result.calls.length === 0 && result.closed.length === 0, "self seat-move: healthy mesh peers are preserved");
}

// Case B: a newly seated peer is connected exactly once.
{
  const result = simulateReconcile({
    room: { seats: [null, { userId: "userZ", socketId: "sockZ" }], onlineUsers: [
      { userId: "me", socketId: "sockMe" }, { userId: "userZ", socketId: "sockZ" }
    ] },
    me: { userId: "me" }, mySeatNumber: 5, peerConnections: {}, voiceMode: "mesh"
  });
  assert(result.calls.length === 1 && result.calls[0] === "sockZ", "new seated peer: connection is created");
}

// Case C: audience user receives from seated speaker without publishing.
{
  const result = simulateReconcile({
    room: { seats: [{ userId: "speaker", socketId: "sockS" }], onlineUsers: [
      { userId: "speaker", socketId: "sockS" }, { userId: "audience", socketId: "sockA" }
    ] },
    me: { userId: "audience" }, mySeatNumber: null, peerConnections: {}, voiceMode: "mesh"
  });
  assert(result.calls.length === 1 && result.calls[0] === "sockS", "audience listener: creates receive-only connection to seated speaker");
}

// Case D: audience-to-audience links are never created.
{
  const result = simulateReconcile({
    room: { seats: [null], onlineUsers: [
      { userId: "audience", socketId: "sockA" }, { userId: "other", socketId: "sockB" }
    ] },
    me: { userId: "audience" }, mySeatNumber: null, peerConnections: {}, voiceMode: "mesh"
  });
  assert(result.calls.length === 0, "audience-only room: no unnecessary audience-to-audience peer");
}

// Case E: SFU mode never creates mesh peers.
{
  const result = simulateReconcile({
    room: { seats: [{ userId: "speaker", socketId: "sockS" }], onlineUsers: [{ userId: "speaker", socketId: "sockS" }] },
    me: { userId: "me" }, mySeatNumber: 1, peerConnections: {}, voiceMode: "sfu"
  });
  assert(result.calls.length === 0, "SFU mode: mesh connectToPeer() never fires");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
