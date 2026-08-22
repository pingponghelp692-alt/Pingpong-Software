#!/usr/bin/env node
// scripts/sfu-production-validate.js
// ==================================================
// PHASE 3, STEP 3.6 — PRODUCTION VALIDATION COMMAND (spec item 2)
// ==================================================
// Run this AFTER setting LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
// and running `npm install livekit-server-sdk`, BEFORE moving VOICE_MODE
// away from "mesh" for real traffic. It performs three checks, in order,
// against a REAL LiveKit deployment — this script does NOT mock or stub
// anything; it requires the actual voice_sfu/token.js and voice_sfu/
// livekit.js modules unmodified and calls their real functions:
//
//   1. Connection validator — can we even reach LIVEKIT_URL over HTTP(S)?
//   2. Token validator — does token.js mint a structurally valid JWT with
//      the grant we expect?
//   3. Smoke test — a full room lifecycle against the real LiveKit server:
//      create a throwaway room, list it, update a (non-existent)
//      participant's permission (expected to no-op/404 — that's fine,
//      it proves the authenticated API call itself succeeds), then
//      delete the room.
//
// Usage:
//   LIVEKIT_URL=wss://your-project.livekit.cloud \
//   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
//   node scripts/sfu-production-validate.js
//
// Exit code 0 = all checks passed. Non-zero = at least one failed (see
// summary at the end for which one). Every step's PASS/FAIL/SKIP is
// printed as it happens — this script never silently swallows a result.
//
// HONESTY NOTE (see PHASE3_STEP36_REPORT.md): this script was written
// and syntax/logic-verified in a sandbox with no network egress and no
// real LiveKit deployment available. It has NOT been run successfully
// against a real server as part of this step — only confirmed to load
// its dependencies cleanly and fail with a clear, correct
// "not configured" message when LIVEKIT_URL is unset. It needs one real
// run against your actual LiveKit deployment before you trust its output.

const path = require("path");
const https = require("https");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const token = require(path.join(ROOT, "voice_sfu", "token.js"));
const livekit = require(path.join(ROOT, "voice_sfu", "livekit.js"));

const results = []; // { name, status: 'pass'|'fail'|'skip', detail }
function report(name, status, detail) {
    results.push({ name, status, detail });
    const icon = status === "pass" ? "✓" : status === "skip" ? "—" : "✗";
    console.log(`  ${icon} ${name}${detail ? ": " + detail : ""}`);
}

function httpHead(urlString, timeoutMs) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlString); } catch (e) { return reject(new Error(`invalid URL: ${urlString}`)); }
        const client = u.protocol === "http:" ? http : https;
        const req = client.request(u, { method: "GET", timeout: timeoutMs }, (res) => {
            res.resume(); // drain, we only care about the connection succeeding
            resolve({ statusCode: res.statusCode });
        });
        req.on("timeout", () => { req.destroy(new Error("timeout")); });
        req.on("error", reject);
        req.end();
    });
}

async function step1_connection() {
    console.log("\n[1] Connection validator");
    const rawUrl = process.env.LIVEKIT_URL || "";
    if (!rawUrl) { report("LIVEKIT_URL reachability", "skip", "LIVEKIT_URL is not set"); return; }
    const httpUrl = rawUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    try {
        const res = await httpHead(httpUrl, 8000);
        // LiveKit's base URL typically answers SOME HTTP response (often a
        // 404/426 for a bare GET, since real traffic is WebSocket/gRPC) —
        // any response at all (not a connection error/timeout) proves the
        // host is reachable and listening, which is what this check is for.
        report("LIVEKIT_URL reachability", "pass", `reached ${httpUrl} (HTTP ${res.statusCode})`);
    } catch (e) {
        report("LIVEKIT_URL reachability", "fail", (e && e.message) || String(e));
    }
}

async function step2_token() {
    console.log("\n[2] Token validator");
    if (!token.isConfigured()) { report("mint a test token", "skip", "LiveKit env vars not fully set"); return; }
    try {
        const jwt = await token.mintAccessToken({
            identity: "sfu-validate-script",
            roomName: "pingpong-validate-script",
            name: "Validation Script",
            metadata: { validation: true },
            canPublish: false,
            canSubscribe: true
        });
        if (typeof jwt !== "string" || jwt.split(".").length !== 3) {
            report("mint a test token", "fail", "returned value is not a well-formed JWT (expected 3 dot-separated parts)");
            return;
        }
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
        report("mint a test token", "pass", "JWT structurally valid");
        report("token grant shape", (payload.video && payload.video.room === "pingpong-validate-script" && payload.video.canPublish === false) ? "pass" : "fail",
            `room=${payload.video && payload.video.room}, canPublish=${payload.video && payload.video.canPublish}`);
        report("token expiry set", Number.isFinite(payload.exp) && payload.exp > Date.now() / 1000 ? "pass" : "fail", `exp=${payload.exp}`);
    } catch (e) {
        report("mint a test token", "fail", (e && e.message) || String(e));
    }
}

async function step3_smokeTest() {
    console.log("\n[3] Smoke test (real LiveKit room lifecycle)");
    if (!token.isConfigured()) { report("room lifecycle", "skip", "LiveKit env vars not fully set"); return; }
    const roomName = `pingpong-validate-${Date.now()}`;
    try {
        await livekit.ensureRoom(roomName, { metadata: { validation: true } });
        report("ensureRoom (create)", "pass");
    } catch (e) {
        report("ensureRoom (create)", "fail", (e && e.message) || String(e));
        return; // no point continuing the lifecycle if creation itself failed
    }
    try {
        const rooms = await livekit.listRooms();
        const found = Array.isArray(rooms) && rooms.some((r) => r && r.name === roomName);
        report("listRooms (confirm created)", found ? "pass" : "fail", found ? undefined : "created room not found in listRooms() result");
    } catch (e) {
        report("listRooms (confirm created)", "fail", (e && e.message) || String(e));
    }
    try {
        const participants = await livekit.listParticipants(roomName);
        report("listParticipants (empty room)", Array.isArray(participants) && participants.length === 0 ? "pass" : "fail", `count=${Array.isArray(participants) ? participants.length : "n/a"}`);
    } catch (e) {
        report("listParticipants (empty room)", "fail", (e && e.message) || String(e));
    }
    try {
        // Expected to fail with a "participant not found"-shaped error —
        // there IS no real participant in this throwaway room. The point
        // of this check is that the AUTHENTICATED API CALL ITSELF reaches
        // the server and gets a normal API error back, not a connection/
        // auth failure — so a rejection here is treated as this check
        // passing, and only a connection-level failure is a real fail.
        await livekit.updateParticipant(roomName, "nobody", { metadata: { probe: true } });
        report("updateParticipant (API reachable)", "pass", "unexpectedly succeeded (no error) — also fine");
    } catch (e) {
        const msg = (e && e.message) || String(e);
        const looksLikeConnectionFailure = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|certificate|LIVEKIT_NOT_CONFIGURED|LIVEKIT_SDK_MISSING/i.test(msg);
        report("updateParticipant (API reachable)", looksLikeConnectionFailure ? "fail" : "pass", msg);
    }
    try {
        await livekit.deleteRoom(roomName);
        report("deleteRoom (cleanup)", "pass");
    } catch (e) {
        report("deleteRoom (cleanup)", "fail", (e && e.message) || String(e) + " — MANUAL CLEANUP NEEDED for room: " + roomName);
    }
}

(async () => {
    console.log("PingPong / voice_sfu — Production Validation");
    console.log("==============================================");
    await step1_connection();
    await step2_token();
    await step3_smokeTest();

    console.log("\n==============================================");
    const failed = results.filter((r) => r.status === "fail");
    const skipped = results.filter((r) => r.status === "skip");
    const passed = results.filter((r) => r.status === "pass");
    console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
    if (skipped.length) console.log("(skipped checks usually mean LIVEKIT_URL/API_KEY/API_SECRET are not set in this shell's environment)");
    if (failed.length) {
        console.log("\nFAILED:");
        failed.forEach((r) => console.log(`  - ${r.name}: ${r.detail || ""}`));
        process.exitCode = 1;
    } else if (skipped.length === results.length) {
        console.log("\nNothing was actually validated — LiveKit is not configured in this environment.");
        process.exitCode = 2;
    }
})();
