#!/usr/bin/env node
// scripts/sfu-load-test.js
// ==================================================
// PHASE 3, STEP 3.6 — PRODUCTION LOAD-TEST TOOLING (spec item 3)
// ==================================================
// Real, runnable load-test scripts against a real LiveKit deployment —
// this file calls the actual voice_sfu/token.js and voice_sfu/livekit.js
// (which call the real livekit-server-sdk), never a mock. It does NOT
// touch server.js, socket.io, or any real PingPong room — it drives
// voice_sfu's LiveKit-facing functions directly and in isolation, which
// is sufficient to load-test the LiveKit-facing surface (token minting,
// room creation, permission updates, room cleanup) without needing a
// running PingPong server or real browser clients.
//
// Scenarios (spec item 3's list, one per CLI arg):
//   joins        — N simultaneous "joins" (ensureRoom + mintAccessToken)
//                  across a fixed number of rooms
//   reconnects   — a "reconnect storm": the same N identities repeatedly
//                  mint a fresh token in a tight loop (simulates a burst
//                  of clients reconnecting after a network blip)
//   room-cycles  — repeatedly create then delete rooms (open/close churn)
//   seat-changes — repeatedly call updateParticipant with alternating
//                  canPublish true/false (simulates seat<->audience
//                  churn, including this step's new audience feature)
//   tokens       — pure token-minting burst, no LiveKit room calls at all
//                  (isolates token.js's own CPU cost from network calls)
//
// Usage:
//   LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
//   node scripts/sfu-load-test.js <scenario> [--n=50] [--rooms=5] [--concurrency=10]
//
// Prints min/avg/p95/max latency and error count per scenario. Exit code
// is non-zero if ANY operation failed.
//
// HONESTY NOTE (see PHASE3_STEP36_REPORT.md): written and logic-checked
// in a sandbox with no network egress — it has NOT been run against a
// real LiveKit deployment as part of this step. Needs one real run
// before its numbers can be trusted for a capacity-planning decision.

const path = require("path");
const ROOT = path.join(__dirname, "..");
const token = require(path.join(ROOT, "voice_sfu", "token.js"));
const livekit = require(path.join(ROOT, "voice_sfu", "livekit.js"));

function parseArgs(argv) {
    const out = { scenario: argv[2], n: 50, rooms: 5, concurrency: 10 };
    argv.slice(3).forEach((a) => {
        const m = /^--(\w+)=(.+)$/.exec(a);
        if (m) out[m[1]] = Number(m[2]);
    });
    return out;
}

function stats(samplesMs) {
    if (!samplesMs.length) return { min: null, avg: null, p95: null, max: null, count: 0 };
    const sorted = samplesMs.slice().sort((a, b) => a - b);
    const p95idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
        min: sorted[0],
        avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p95: sorted[p95idx],
        max: sorted[sorted.length - 1],
        count: sorted.length
    };
}

// Runs `count` async operations with at most `concurrency` in flight at
// once — a simple worker-pool, not a true fixed-rate load generator
// (that would need its own timer-based scheduler); adequate for "many
// simultaneous joins"-style burst testing, not for sustained-throughput
// modeling. Flagged here rather than oversold as more than it is.
async function runPool(count, concurrency, fn) {
    const latencies = [];
    let errors = 0;
    let next = 0;
    async function worker() {
        while (next < count) {
            const i = next++;
            const startedAt = Date.now();
            try { await fn(i); latencies.push(Date.now() - startedAt); }
            catch (e) { errors++; console.error(`  [error #${i}] ${(e && e.message) || e}`); }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, count) }, worker);
    await Promise.all(workers);
    return { latencies, errors };
}

async function scenarioJoins({ n, rooms, concurrency }) {
    console.log(`Scenario: joins — ${n} simulated joins across ${rooms} rooms, concurrency=${concurrency}`);
    const roomNames = Array.from({ length: rooms }, (_, i) => `pingpong-loadtest-joins-${i}`);
    for (const r of roomNames) await livekit.ensureRoom(r, { metadata: { loadtest: true } });
    const { latencies, errors } = await runPool(n, concurrency, async (i) => {
        const roomName = roomNames[i % roomNames.length];
        await token.mintAccessToken({ identity: `lt-user-${i}`, roomName, name: `LoadTest ${i}`, canPublish: i % 3 === 0, canSubscribe: true });
    });
    for (const r of roomNames) { try { await livekit.deleteRoom(r); } catch (e) { console.error(`  cleanup failed for ${r}: ${e.message}`); } }
    return { latencies, errors };
}

async function scenarioReconnects({ n, concurrency }) {
    console.log(`Scenario: reconnects — ${n} rapid re-mints for the same identities, concurrency=${concurrency}`);
    const roomName = "pingpong-loadtest-reconnects";
    await livekit.ensureRoom(roomName, { metadata: { loadtest: true } });
    const identityPoolSize = Math.max(1, Math.floor(n / 5)); // same identities reconnect repeatedly, not N distinct users
    const { latencies, errors } = await runPool(n, concurrency, async (i) => {
        await token.mintAccessToken({ identity: `lt-reconnect-${i % identityPoolSize}`, roomName, canPublish: true, canSubscribe: true });
    });
    try { await livekit.deleteRoom(roomName); } catch (e) { console.error(`  cleanup failed: ${e.message}`); }
    return { latencies, errors };
}

async function scenarioRoomCycles({ n, concurrency }) {
    console.log(`Scenario: room-cycles — ${n} create+delete cycles, concurrency=${concurrency}`);
    const { latencies, errors } = await runPool(n, concurrency, async (i) => {
        const roomName = `pingpong-loadtest-cycle-${i}`;
        await livekit.ensureRoom(roomName, { metadata: { loadtest: true } });
        await livekit.deleteRoom(roomName);
    });
    return { latencies, errors };
}

async function scenarioSeatChanges({ n, concurrency }) {
    console.log(`Scenario: seat-changes — ${n} permission updates (alternating publish/audience), concurrency=${concurrency}`);
    const roomName = "pingpong-loadtest-seatchanges";
    await livekit.ensureRoom(roomName, { metadata: { loadtest: true } });
    const { latencies, errors } = await runPool(n, concurrency, async (i) => {
        const canPublish = i % 2 === 0;
        await livekit.updateParticipant(roomName, `lt-seat-${i % 10}`, {
            metadata: { canPublish },
            permission: { canPublish, canSubscribe: true, canPublishData: true }
        }).catch((e) => {
            // "participant not found" is expected here (no real connected
            // client) — same reasoning as sfu-production-validate.js's
            // updateParticipant check. Only re-throw if it looks like a
            // connection/auth failure, not a normal not-found.
            const msg = (e && e.message) || String(e);
            if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|certificate|LIVEKIT_NOT_CONFIGURED|LIVEKIT_SDK_MISSING/i.test(msg)) throw e;
        });
    });
    try { await livekit.deleteRoom(roomName); } catch (e) { console.error(`  cleanup failed: ${e.message}`); }
    return { latencies, errors };
}

async function scenarioTokens({ n, concurrency }) {
    console.log(`Scenario: tokens — ${n} pure token mints (no LiveKit room API calls), concurrency=${concurrency}`);
    const { latencies, errors } = await runPool(n, concurrency, async (i) => {
        await token.mintAccessToken({ identity: `lt-token-${i}`, roomName: "pingpong-loadtest-tokens-only", canPublish: false, canSubscribe: true });
    });
    return { latencies, errors };
}

const SCENARIOS = { joins: scenarioJoins, reconnects: scenarioReconnects, "room-cycles": scenarioRoomCycles, "seat-changes": scenarioSeatChanges, tokens: scenarioTokens };

(async () => {
    const args = parseArgs(process.argv);
    if (!args.scenario || !SCENARIOS[args.scenario]) {
        console.log("Usage: node scripts/sfu-load-test.js <scenario> [--n=50] [--rooms=5] [--concurrency=10]");
        console.log("Scenarios:", Object.keys(SCENARIOS).join(", "));
        process.exitCode = 2;
        return;
    }
    if (!token.isConfigured()) {
        console.log("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing) — nothing to load-test.");
        console.log("This tooling is implemented and ready to run once a real deployment is configured; it has not been executed against one yet (see PHASE3_STEP36_REPORT.md).");
        process.exitCode = 2;
        return;
    }
    console.log("PingPong / voice_sfu — Load Test");
    console.log("==================================");
    const startedAt = Date.now();
    const { latencies, errors } = await SCENARIOS[args.scenario](args);
    const s = stats(latencies);
    console.log("\nResults:");
    console.log(`  total time:   ${Date.now() - startedAt}ms`);
    console.log(`  operations:   ${s.count}`);
    console.log(`  errors:       ${errors}`);
    console.log(`  latency ms:   min=${s.min} avg=${s.avg} p95=${s.p95} max=${s.max}`);
    process.exitCode = errors > 0 ? 1 : 0;
})();
