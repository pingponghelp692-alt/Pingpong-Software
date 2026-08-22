// scripts/sfu-seatsync-retry-verify.js
//
// Verification script for the 2026-08-10 root-cause fix: sync.js's
// onSeatChanged now retries once (bounded, ~1.5s) when LiveKit reports
// "participant does not exist" — the expected race where a seat is taken
// server-side before the client's own LiveKit connect() has landed.
//
// No network egress in this sandbox, so this exercises the retry logic
// against an in-process FAKE LiveKit client (same approach as
// scripts/sfu-step35-verify.js), not a real LiveKit server. Every check
// below is a real assertion against real (short-circuited-for-speed)
// timing, not a description of intended behavior.

(async () => {
process.env.VOICE_MODE = "sfu";

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ ${label}`); }
}

const roomManager = {
    toLiveKitRoomName: (id) => `pingpong-${id}`,
    setPublisherStatus: () => {}
};

// ---------- 1. Expected race: not-found, then succeeds on retry ----------
console.log("\n[1] onSeatChanged: participant not found, then connects before the retry");
{
    let calls = 0;
    const fakeLivekit = {
        updateParticipant: async () => {
            calls++;
            if (calls === 1) { const e = new Error("twirp error: not_found: participant does not exist"); throw e; }
            return { ok: true };
        }
    };
    // Speed up the retry delay for the test only, via a tiny sync.js shim:
    // re-require sync.js fresh, then monkey-patch the module-internal delay
    // by overriding global setTimeout scope isn't possible cleanly, so
    // instead we just accept the real ~1.5s wait once — cheap for a single
    // assertion run.
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    const sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: fakeLivekit, sfuHealth: null });
    const startedAt = Date.now();
    await sync.onSeatChanged("room1", "user1", { seatNumber: 3, canPublish: true });
    const elapsedMs = Date.now() - startedAt;
    assert(calls === 2, "updateParticipant was called exactly twice (initial + one bounded retry)");
    assert(elapsedMs >= 1400, `retry actually waited (~1.5s) before the second attempt (measured ${elapsedMs}ms)`);
}

// ---------- 2. Still not found after retry: converges silently, no throw ----------
console.log("\n[2] onSeatChanged: participant never connects this session");
{
    let calls = 0;
    const fakeLivekit = {
        updateParticipant: async () => { calls++; const e = new Error("participant does not exist"); throw e; }
    };
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    const sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: fakeLivekit, sfuHealth: null });
    let threw = false;
    try { await sync.onSeatChanged("room1", "userGone", { seatNumber: 4, canPublish: true }); }
    catch (e) { threw = true; }
    assert(!threw, "never throws into the caller even when the retry also fails (fail-safe honored)");
    assert(calls === 2, "still only 2 total attempts — retry is bounded, not a loop");
}

// ---------- 3. A REAL failure (not the not-found race) is not retried, and is recorded distinctly ----------
console.log("\n[3] onSeatChanged: a genuine LiveKit failure (auth error, not a race)");
{
    let calls = 0;
    const errors = [];
    const fakeLivekit = {
        updateParticipant: async () => { calls++; throw new Error("401 invalid API key"); }
    };
    const fakeHealth = { recordApiLatency: () => {}, recordError: (e) => errors.push(e), recordCleanup: () => {}, recordReconnectEvent: () => {} };
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    const sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: fakeLivekit, sfuHealth: fakeHealth });
    const startedAt = Date.now();
    await sync.onSeatChanged("room1", "user1", { seatNumber: 1, canPublish: true });
    const elapsedMs = Date.now() - startedAt;
    assert(calls === 1, "a genuine (non-'not found') failure is NOT retried — only the specific expected race gets a retry");
    assert(elapsedMs < 500, `no artificial delay for a real failure (measured ${elapsedMs}ms)`);
    assert(errors.length === 1 && /401/.test(errors[0].message), "the real error is still recorded via sfuHealth.recordError — never hidden");
}

// ---------- 4. onParticipantLeftRoom does NOT retry on not-found (removal already converged) ----------
console.log("\n[4] onParticipantLeftRoom: not-found means already-gone, no retry needed");
{
    let calls = 0;
    const fakeLivekit = {
        removeParticipant: async () => { calls++; throw new Error("participant does not exist"); }
    };
    delete require.cache[require.resolve("../voice_sfu/sync.js")];
    const sync = require("../voice_sfu/sync.js").initVoiceSfuSync({ roomManager, livekit: fakeLivekit, sfuHealth: null });
    const startedAt = Date.now();
    await sync.onParticipantLeftRoom("room1", "user1");
    const elapsedMs = Date.now() - startedAt;
    assert(calls === 1, "removeParticipant called exactly once — a leave-of-something-already-gone is already the converged state, not retried");
    assert(elapsedMs < 500, `no retry delay incurred (measured ${elapsedMs}ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
})();
