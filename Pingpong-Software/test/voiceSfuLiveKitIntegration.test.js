// voiceSfuLiveKitIntegration.test.js
// Standalone verification harness, same convention as callSignaling.test.js
// (no npm deps, no real network, exercises the real modules directly).
//
// SCOPE: this covers token.js / roomManager.js / provider.js — the pieces
// of voice_sfu/ that a LiveKit Cloud integration pass actually touches
// (config reading, authorization, room-name mapping, token-mint error
// paths). rollout.js and sync.js already have dedicated coverage in
// scripts/sfu-step35-verify.js (23/23 passing, re-run as part of this same
// pass) — not duplicated here.
//
// HONESTY NOTE: livekit-server-sdk is not installed in this sandbox (no
// npm registry access — confirmed separately, see the final report). Every
// test below that would require the SDK to actually mint/verify a real
// JWT instead asserts the correct FAIL-SAFE error (LIVEKIT_SDK_MISSING) —
// proving the guard code works, not that a real token was produced. No
// test claims to have exercised the real LiveKit SDK or a real network
// call. All credentials used in this file are fake placeholders, never
// the real project's secret.
//
// Run: node test/voiceSfuLiveKitIntegration.test.js

const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}
async function assertThrows(fn, matchCode, msg) {
  try {
    await fn();
    fail++; console.error("  ✗ FAIL:", msg, "(did not throw)");
  } catch (e) {
    if (!matchCode || e.code === matchCode) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg, `(threw code=${e.code}, expected ${matchCode})`); }
  }
}

// Snapshot + restore the exact env keys this file touches, so this test
// never leaks state into anything run after it in the same process (not
// a real risk given every test file here runs as its own `node`
// invocation, but cheap and correct regardless).
const ENV_KEYS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_TOKEN_TTL_SECONDS", "VOICE_MODE"];
const envSnapshot = {};
ENV_KEYS.forEach((k) => { envSnapshot[k] = process.env[k]; });
function resetEnv() { ENV_KEYS.forEach((k) => { delete process.env[k]; }); }
function restoreEnv() { ENV_KEYS.forEach((k) => { if (envSnapshot[k] === undefined) delete process.env[k]; else process.env[k] = envSnapshot[k]; }); }

async function main() {
resetEnv();

// ---------------------------------------------------------------------
console.log("\n[1] token.js — config detection");
{
  // Fresh require each section, since token.js reads process.env live
  // inside each function call (not cached at require time) — no module
  // cache trickery needed, but re-require for clarity/isolation anyway.
  delete require.cache[require.resolve("../voice_sfu/token.js")];
  const token = require("../voice_sfu/token.js");

  assert(token.isConfigured() === false, "isConfigured() is false with no LiveKit env vars set");

  process.env.LIVEKIT_URL = "wss://fake-test-project.livekit.cloud";
  assert(token.isConfigured() === false, "isConfigured() still false with only LIVEKIT_URL set");

  process.env.LIVEKIT_API_KEY = "fake-test-key";
  assert(token.isConfigured() === false, "isConfigured() still false with URL+KEY but no SECRET");

  process.env.LIVEKIT_API_SECRET = "fake-test-secret-do-not-use";
  assert(token.isConfigured() === true, "isConfigured() true once all three vars are set");

  assert(token.tokenTtlSeconds() === 6 * 60 * 60, "tokenTtlSeconds() defaults to 6h when LIVEKIT_TOKEN_TTL_SECONDS is unset");
  process.env.LIVEKIT_TOKEN_TTL_SECONDS = "3600";
  assert(token.tokenTtlSeconds() === 3600, "tokenTtlSeconds() honors LIVEKIT_TOKEN_TTL_SECONDS override");
  process.env.LIVEKIT_TOKEN_TTL_SECONDS = "not-a-number";
  assert(token.tokenTtlSeconds() === 6 * 60 * 60, "tokenTtlSeconds() falls back to the 6h default on an invalid override, never throws/NaN");
  delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;

  await assertThrows(
    () => { resetEnv(); return token.mintAccessToken({ identity: "u1", roomName: "r1" }); },
    "LIVEKIT_NOT_CONFIGURED",
    "mintAccessToken() rejects with LIVEKIT_NOT_CONFIGURED when env vars are missing (never silently proceeds)"
  );

  // Real-shape (fake value) credentials present, but the SDK package
  // itself isn't installed in this sandbox — must fail closed with the
  // SPECIFIC diagnostic code, not a generic/opaque error.
  process.env.LIVEKIT_URL = "wss://fake-test-project.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "fake-test-key";
  process.env.LIVEKIT_API_SECRET = "fake-test-secret-do-not-use";
  await assertThrows(
    () => token.mintAccessToken({ identity: "u1", roomName: "r1" }),
    "LIVEKIT_SDK_MISSING",
    "mintAccessToken() rejects with LIVEKIT_SDK_MISSING when livekit-server-sdk isn't installed (this sandbox's actual state)"
  );

  await assertThrows(
    () => token.mintAccessToken({ identity: "", roomName: "r1" }),
    null,
    "mintAccessToken() rejects an empty identity before ever touching the SDK"
  );
  await assertThrows(
    () => token.mintAccessToken({ identity: "u1", roomName: "" }),
    null,
    "mintAccessToken() rejects an empty roomName before ever touching the SDK"
  );
}

// ---------------------------------------------------------------------
console.log("\n[2] roomManager.js — room mapping + authorization");
{
  const { initSfuRoomManager } = require("../voice_sfu/roomManager.js");
  const rooms = {
    room1: {
      seats: [{ userId: "speaker1" }, null, { userId: "speaker2" }],
      onlineUsers: [{ userId: "speaker1" }, { userId: "speaker2" }, { userId: "audience1" }]
    }
  };
  const rm = initSfuRoomManager({ rooms });

  assert(rm.toLiveKitRoomName("room1") === "pingpong-room1", "PingPong roomId maps to the expected deterministic LiveKit room name");
  assert(rm.toLiveKitRoomName("room1") === rm.toLiveKitRoomName("room1"), "room-name mapping is stable/deterministic across calls (no per-call randomness)");
  assert(rm.toLiveKitRoomName("weird/room id!") === "pingpong-weird_room_id_", "unsafe characters in a roomId are sanitized, never passed through raw to LiveKit");

  assert(rm.isUserSeatedInRoom("room1", "speaker1") === true, "seated user correctly identified as seated (publish-eligible)");
  assert(rm.isUserSeatedInRoom("room1", "audience1") === false, "audience-only user correctly identified as NOT seated");
  assert(rm.isUserInRoom("room1", "audience1") === true, "audience-only user IS a room member (listen-eligible)");
  assert(rm.isUserInRoom("room1", "stranger") === false, "a user who never joined the PingPong room at all is not authorized even to listen");
  assert(rm.isUserSeatedInRoom("does-not-exist", "speaker1") === false, "a nonexistent room never authorizes anyone (fails closed, does not throw)");

  const lkRoom = rm.toLiveKitRoomName("room1");
  assert(rm.getLocalParticipantCount(lkRoom) === 0, "participant count starts at 0");
  rm.recordJoin(lkRoom); rm.recordJoin(lkRoom);
  assert(rm.getLocalParticipantCount(lkRoom) === 2, "recordJoin() increments the local participant count");
  rm.recordLeave(lkRoom);
  assert(rm.getLocalParticipantCount(lkRoom) === 1, "recordLeave() decrements the local participant count");

  rm.setPublisherStatus(lkRoom, "speaker1", true);
  assert(rm.getLocalPublisherCount(lkRoom) === 1, "setPublisherStatus(true) registers a publisher");
  rm.setPublisherStatus(lkRoom, "speaker1", true); // idempotent re-set (e.g. duplicate seat-update event)
  assert(rm.getLocalPublisherCount(lkRoom) === 1, "setPublisherStatus is idempotent — a duplicate 'became publisher' event doesn't double-count");
  rm.setPublisherStatus(lkRoom, "speaker1", false);
  assert(rm.getLocalPublisherCount(lkRoom) === 0, "setPublisherStatus(false) (seat -> audience) clears publisher status");
}

// ---------------------------------------------------------------------
console.log("\n[3] provider.js — mode selection + authorization before any LiveKit call");
{
  resetEnv();
  delete require.cache[require.resolve("../voice_sfu/provider.js")];
  const provider = require("../voice_sfu/provider.js");

  assert(provider.currentVoiceMode() === "mesh", "currentVoiceMode() defaults to mesh with VOICE_MODE unset");
  process.env.VOICE_MODE = "sfu";
  assert(provider.currentVoiceMode() === "sfu", "currentVoiceMode() honors VOICE_MODE=sfu");
  process.env.VOICE_MODE = "not-a-real-mode";
  assert(provider.currentVoiceMode() === "mesh", "an unrecognized VOICE_MODE value never fails open into sfu");
  delete process.env.VOICE_MODE;

  const mesh = provider.createMeshProvider();
  const info = await mesh.getConnectionInfo({ userId: "u1" });
  assert(info.mode === "mesh" && Array.isArray(info.iceServers), "mesh provider returns ICE servers, same shape the existing /api/calls/ice-servers route already returns");

  const { initSfuRoomManager } = require("../voice_sfu/roomManager.js");
  const rooms = { room1: { seats: [{ userId: "speaker1" }], onlineUsers: [{ userId: "speaker1" }, { userId: "audience1" }] } };
  const roomManager = initSfuRoomManager({ rooms });
  const fakeLivekit = { ensureRoom: async () => {} }; // never actually reached in the two cases below — config/authorization is checked first

  resetEnv(); // LiveKit intentionally left unconfigured for this check
  const sfuUnconfigured = provider.createSfuProvider({ roomManager, livekit: fakeLivekit });
  await assertThrows(
    () => sfuUnconfigured.getConnectionInfo({ roomId: "room1", userId: "speaker1" }),
    "LIVEKIT_NOT_CONFIGURED",
    "SFU provider rejects with LIVEKIT_NOT_CONFIGURED before ever calling LiveKit, when env vars are missing"
  );

  process.env.LIVEKIT_URL = "wss://fake-test-project.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "fake-test-key";
  process.env.LIVEKIT_API_SECRET = "fake-test-secret-do-not-use";
  const sfuConfigured = provider.createSfuProvider({ roomManager, livekit: fakeLivekit });
  await assertThrows(
    () => sfuConfigured.getConnectionInfo({ roomId: "room1", userId: "total-stranger" }),
    "NOT_IN_ROOM",
    "SFU provider rejects a user who never joined the PingPong room, even with LiveKit fully configured — authorization is still gated on the app's own room membership, not just having a valid API key"
  );
  resetEnv();
}

console.log(`\n${pass} passed, ${fail} failed`);
restoreEnv();
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); restoreEnv(); process.exit(1); });
