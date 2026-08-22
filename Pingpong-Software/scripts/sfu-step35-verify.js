// scripts/sfu-step35-verify.js
(async () => {
// Standalone verification script for PHASE3_STEP35_REPORT.md.
// Exercises rollout.js, provider.js, sync.js against an in-process FAKE
// livekit client (this sandbox has no network egress — same documented
// limitation as Steps 3.2-3.4's own "not run" sections). Every check
// below is a real assertion, not a description of intended behavior.

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ ${label}`); }
}

// ---------- 1. rollout.js: deterministic per-room decisions ----------
console.log("\n[1] rollout.js");
{
    delete process.env.VOICE_MODE;
    const rollout = require("../voice_sfu/rollout.js");
    assert(rollout.rawBaseMode() === "mesh", "unset VOICE_MODE -> mesh");

    process.env.VOICE_MODE = "sfu";
    assert(rollout.resolveRoomVoiceMode("room1", null) === "sfu", "VOICE_MODE=sfu -> every room sfu");

    process.env.VOICE_MODE = "mesh";
    assert(rollout.resolveRoomVoiceMode("room1", null) === "mesh", "VOICE_MODE=mesh -> every room mesh");

    process.env.VOICE_MODE = "garbage";
    assert(rollout.resolveRoomVoiceMode("room1", null) === "mesh", "unrecognized VOICE_MODE never fails open");

    process.env.VOICE_MODE = "staged";
    delete process.env.SFU_STAGE_ALLOWLIST_ROOMS;
    delete process.env.SFU_STAGE_ALLOWLIST_HOSTS;
    delete process.env.SFU_STAGE_PERCENT;
    assert(rollout.resolveRoomVoiceMode("room1", null) === "mesh", "staged with no knobs set -> fails closed to mesh");

    process.env.SFU_STAGE_ALLOWLIST_ROOMS = "room1,room2";
    assert(rollout.resolveRoomVoiceMode("room1", null) === "sfu", "staged + room allowlist match -> sfu");
    assert(rollout.resolveRoomVoiceMode("room3", null) === "mesh", "staged + room allowlist non-match -> mesh");
    delete process.env.SFU_STAGE_ALLOWLIST_ROOMS;

    process.env.SFU_STAGE_ALLOWLIST_HOSTS = "hostA";
    assert(rollout.resolveRoomVoiceMode("roomX", { hostId: "hostA" }) === "sfu", "staged + host allowlist match -> sfu");
    assert(rollout.resolveRoomVoiceMode("roomX", { hostId: "hostB" }) === "mesh", "staged + host allowlist non-match -> mesh");
    assert(rollout.resolveRoomVoiceMode("roomX", null) === "mesh", "staged + host allowlist, null room -> mesh (no throw)");
    delete process.env.SFU_STAGE_ALLOWLIST_HOSTS;

    process.env.SFU_STAGE_PERCENT = "100";
    assert(rollout.resolveRoomVoiceMode("anyRoom", null) === "sfu", "staged + 100% -> sfu");
    process.env.SFU_STAGE_PERCENT = "0";
    assert(rollout.resolveRoomVoiceMode("anyRoom", null) === "mesh", "staged + 0% -> mesh");
    process.env.SFU_STAGE_PERCENT = "50";
    // Determinism: same room, same config, called 5x -> same answer every time.
    const results = new Set();
    for (let i = 0; i < 5; i++) results.add(rollout.resolveRoomVoiceMode("stableRoom", null));
    assert(results.size === 1, "staged + percent: same room always resolves the same way (no per-request flapping)");
    // Rough distribution sanity check over many distinct room ids.
    let sfuCount = 0;
    for (let i = 0; i < 2000; i++) if (rollout.resolveRoomVoiceMode(`room-${i}`, null) === "sfu") sfuCount++;
    const pct = sfuCount / 2000 * 100;
    assert(pct > 40 && pct < 60, `staged + 50% -> roughly 50% of rooms get sfu (measured ${pct.toFixed(1)}%)`);
    delete process.env.SFU_STAGE_PERCENT;

    process.env.VOICE_MODE = "mesh";
    delete process.env.SFU_STAGE_ALLOWLIST_ROOMS;
}

// ---------- 2. sync.js: per-room gating + fail-safe against a broken LiveKit ----------
console.log("\n[2] sync.js (fake LiveKit)");
{
    delete process.env.VOICE_MODE;
    delete process.env.SFU_STAGE_ALLOWLIST_ROOMS;
    delete process.env.SFU_STAGE_ALLOWLIST_HOSTS;
    delete process.env.SFU_STAGE_PERCENT;

    const calls = [];
    function makeFakeLivekit(shouldThrow) {
        const record = (name) => (...args) => {
            calls.push(name);
            if (shouldThrow) throw new Error(`simulated ${name} failure`);
            return Promise.resolve();
        };
        return {
            deleteRoom: record("deleteRoom"),
            listParticipants: (...a) => { calls.push("listParticipants"); if (shouldThrow) throw new Error("simulated listParticipants failure"); return Promise.resolve([]); },
            removeParticipant: record("removeParticipant"),
            updateParticipant: record("updateParticipant"),
        };
    }

    const rooms = { staged1: { hostId: "hostA", onlineUsers: [] }, mesh1: { hostId: "hostB", onlineUsers: [] } };
    const roomManager = { toLiveKitRoomName: (id) => `pingpong-${id}`, getPingPongRoom: (id) => rooms[id] || null, clearLocalCount: () => {} };
    const sfuHealthEvents = { errorCount: 0, cleanupCount: 0, reconnectEventCount: 0 };
    const sfuHealth = {
        recordCleanup: () => { sfuHealthEvents.cleanupCount++; },
        recordError: () => { sfuHealthEvents.errorCount++; },
        recordReconnectEvent: () => { sfuHealthEvents.reconnectEventCount++; },
        recordApiLatency: () => {}
    };

    // Mesh-only deployment: zero LiveKit calls for any hook.
    process.env.VOICE_MODE = "mesh";
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    delete require.cache[require.resolve("../voice_sfu/provider.js")];
    let sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: makeFakeLivekit(false), sfuHealth });
    calls.length = 0;
    await sync.onRoomClosed("mesh1");
    await sync.onParticipantLeftRoom("mesh1", "u1");
    sync.onParticipantGraceStart("mesh1", "u1");
    assert(calls.length === 0, "VOICE_MODE=mesh: zero LiveKit calls from any sync.js hook");
    assert(sfuHealthEvents.reconnectEventCount === 0, "VOICE_MODE=mesh: reconnectEventCount not incremented (fixed Step 3.5 bug)");

    // Staged rollout: only the allowlisted room's hooks reach LiveKit.
    process.env.VOICE_MODE = "staged";
    process.env.SFU_STAGE_ALLOWLIST_ROOMS = "staged1";
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    delete require.cache[require.resolve("../voice_sfu/provider.js")];
    sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: makeFakeLivekit(false), sfuHealth });
    calls.length = 0;
    await sync.onRoomClosed("staged1"); // allowlisted -> should call LiveKit
    await sync.onRoomClosed("mesh1");   // not allowlisted -> should NOT call LiveKit
    assert(calls.length === 1 && calls[0] === "deleteRoom", "staged rollout: only the allowlisted room's onRoomClosed reaches LiveKit");

    calls.length = 0;
    sync.onParticipantGraceStart("staged1", "u1");
    await new Promise((r) => setTimeout(r, 10));
    assert(sfuHealthEvents.reconnectEventCount === 1, "staged rollout: reconnect counted for the SFU room");
    sync.onParticipantGraceStart("mesh1", "u2");
    await new Promise((r) => setTimeout(r, 10));
    assert(sfuHealthEvents.reconnectEventCount === 1, "staged rollout: NOT counted for the mesh room (still 1)");

    // Fail-safe: a LiveKit client whose every method throws must never
    // let an exception escape a sync.js function.
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    delete require.cache[require.resolve("../voice_sfu/provider.js")];
    const throwingLivekit = makeFakeLivekit(true);
    const failSync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: throwingLivekit, sfuHealth });
    let threw = false;
    try {
        await failSync.onRoomClosed("staged1");
        await failSync.onParticipantLeftRoom("staged1", "u1");
        failSync.onParticipantGraceStart("staged1", "u1");
        await new Promise((r) => setTimeout(r, 10));
    } catch (e) { threw = true; }
    assert(!threw, "LiveKit throwing on every call: no exception escapes sync.js (fail-safe honored)");
    assert(sfuHealthEvents.errorCount > 0, "LiveKit failures recorded in sfuHealth.errorCount instead of being silently dropped");

    delete process.env.SFU_STAGE_ALLOWLIST_ROOMS;
    process.env.VOICE_MODE = "mesh";
}

// ---------- 3. rollback: flipping VOICE_MODE=mesh mid-"session" fully reverts ----------
console.log("\n[3] rollback semantics");
{
    process.env.VOICE_MODE = "staged";
    process.env.SFU_STAGE_PERCENT = "100";
    delete require.cache[require.resolve("../voice_sfu/rollout.js")];
    let rollout = require("../voice_sfu/rollout.js");
    assert(rollout.resolveRoomVoiceMode("anyRoom", null) === "sfu", "before rollback: staged+100% -> sfu");

    process.env.VOICE_MODE = "mesh"; // the ONLY change a real rollback would make
    assert(rollout.resolveRoomVoiceMode("anyRoom", null) === "mesh", "after VOICE_MODE=mesh: same room instantly mesh, no other change needed");

    delete process.env.SFU_STAGE_PERCENT;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
