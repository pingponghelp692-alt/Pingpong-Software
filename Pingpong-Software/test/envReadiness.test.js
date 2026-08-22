// test/envReadiness.test.js
// Regression tests for envReadiness.js (Phase 6 — env/secrets hardening)
// and turn-config.js's getStatus(). Covers:
//   - the report shape never leaks a secret value, only booleans/enums
//   - each subsystem correctly reports missing/configured from env vars
//   - the production fail-fast only fires in its narrow intended scope
//     (NODE_ENV=production AND an explicit non-mesh VOICE_MODE)
//
// Run: node test/envReadiness.test.js

const path = require("path");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

// Each scenario needs its own env + fresh require cache (module-level
// `process.env` reads happen at call-time here, not at require-time, but
// running each scenario in its own child process is the simplest way to
// guarantee zero cross-contamination between scenarios — no shared
// process.env mutation to carefully undo between tests).
function runScenario(envOverrides, scriptBody) {
    const script = `
        ${Object.entries(envOverrides).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join("\n")}
        const r = require(${JSON.stringify(path.join(__dirname, "..", "envReadiness.js"))});
        ${scriptBody}
    `;
    return execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Extracts just the final line of stdout — needed because turn-config.js
// (required transitively by envReadiness.js) logs a couple of
// non-secret status lines ("[turn-config] STUN loaded...") at
// require-time, which land in the same captured stdout ahead of this
// scenario's actual printed result.
function lastLine(out) {
    const lines = out.trim().split("\n");
    return lines[lines.length - 1];
}

console.log("=== 1. Report shape never contains a secret value, only booleans/enums/strings from a known set ===");
{
    const out = runScenario(
        { LIVEKIT_API_SECRET: "sk_should_never_appear_in_output_abcdef123456", CLOUDFLARE_TURN_API_TOKEN: "cfat_should_never_appear_xyz789" },
        `console.log(JSON.stringify(r.getReadinessReport()));`
    );
    assert(!out.includes("sk_should_never_appear_in_output_abcdef123456"), "the real LIVEKIT_API_SECRET value never appears in the report output");
    assert(!out.includes("cfat_should_never_appear_xyz789"), "the real CLOUDFLARE_TURN_API_TOKEN value never appears in the report output");
    const report = JSON.parse(lastLine(out));
    assert(typeof report.livekit === "string" && typeof report.turn === "string", "livekit/turn are reported as status strings, not raw env dumps");
}

console.log("=== 2. LiveKit reports 'missing' when env vars are absent, 'configured' when all three are present ===");
{
    const missingOut = runScenario({}, `console.log(r.checkLiveKit().configured);`);
    assert(lastLine(missingOut) === "false", "LiveKit reports not configured with no env vars set");
    const configuredOut = runScenario(
        { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "key123", LIVEKIT_API_SECRET: "secret123" },
        `console.log(r.checkLiveKit().configured);`
    );
    assert(lastLine(configuredOut) === "true", "LiveKit reports configured once URL/key/secret are all present");
}

console.log("=== 3. TURN reports 'missing' with nothing set, 'cloudflare' mode once Cloudflare vars are present ===");
{
    const missingOut = runScenario({}, `console.log(r.checkTurn().status);`);
    assert(lastLine(missingOut) === "missing", "TURN reports missing with no env vars set");
    const cfOut = runScenario(
        { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_TURN_KEY_ID: "key1", CLOUDFLARE_TURN_API_TOKEN: "tok1" },
        `console.log(r.checkTurn().status);`
    );
    assert(lastLine(cfOut) === "cloudflare", "TURN reports 'cloudflare' mode once all three Cloudflare vars are present (Phase 7 makes this functional; Phase 6 only reports presence)");
}

console.log("=== 4. Database/Redis/Firebase default to their documented safe-fallback status with nothing configured ===");
{
    const out = runScenario({}, `
        console.log(JSON.stringify({ db: r.checkDatabase().status, redis: r.checkRedis().status, fb: r.checkFirebase().status }));
    `);
    const parsed = JSON.parse(lastLine(out));
    assert(parsed.db === "json", "database falls back to the documented 'json' status when DATABASE_URL isn't set");
    assert(parsed.redis === "disabled", "redis reports 'disabled' (not an error) when not configured — single-instance mode is a valid, documented state");
    assert(parsed.fb === "disabled", "firebase reports 'disabled' (not an error) when not configured — OTP login is unaffected");
}

console.log("=== 5. Production fail-fast: VOICE_MODE=sfu + NODE_ENV=production + no LiveKit config -> throws ===");
{
    const out = runScenario(
        { NODE_ENV: "production", VOICE_MODE: "sfu" },
        `try { r.assertProductionVoiceReadiness(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.code); }`
    );
    assert(lastLine(out) === "THREW:VOICE_SFU_NOT_CONFIGURED", "production + explicit sfu + missing LiveKit config throws the expected error code");
}

console.log("=== 6. Production fail-fast does NOT fire for VOICE_MODE=mesh (explicit valid choice, not a silent fallback) ===");
{
    const out = runScenario(
        { NODE_ENV: "production", VOICE_MODE: "mesh" },
        `try { r.assertProductionVoiceReadiness(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.code); }`
    );
    assert(lastLine(out) === "NO_THROW", "explicit VOICE_MODE=mesh in production is a valid choice and never fails startup");
}

console.log("=== 7. Production fail-fast does NOT fire outside production, even with sfu + no LiveKit config ===");
{
    const out = runScenario(
        { VOICE_MODE: "sfu" }, // NODE_ENV left unset — local/Termux testing default
        `try { r.assertProductionVoiceReadiness(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.code); }`
    );
    assert(lastLine(out) === "NO_THROW", "local/dev/testing (NODE_ENV != production) is never blocked by the production fail-fast, even with an unconfigured sfu request");
}

console.log("=== 8. Production fail-fast DOES fire for VOICE_MODE=staged too (staged can route real traffic to SFU) ===");
{
    const out = runScenario(
        { NODE_ENV: "production", VOICE_MODE: "staged" },
        `try { r.assertProductionVoiceReadiness(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.code); }`
    );
    assert(lastLine(out) === "THREW:VOICE_SFU_NOT_CONFIGURED", "staged mode in production with no LiveKit config also fails fast — staged can send real users to SFU");
}

console.log("=== 9. turn-config.js's getStatus() itself never returns a secret, only mode/configured/stunOnly ===");
{
    const turnConfig = require(path.join(__dirname, "..", "turn-config.js"));
    const status = turnConfig.getStatus();
    const keys = Object.keys(status).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["configured", "mode", "stunOnly"]), "getStatus() returns exactly {configured, mode, stunOnly} — no url/username/credential fields");
}

console.log("=== 10. getPublicHealth() omits firebase (admin-only detail) but keeps the spec's required fields ===");
{
    const out = runScenario({}, `console.log(JSON.stringify(r.getPublicHealth()));`);
    const parsed = JSON.parse(lastLine(out));
    const keys = Object.keys(parsed).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["database", "livekit", "redis", "server", "turn", "voiceMode"]), "public /healthz shape matches spec §28 exactly: server, voiceMode, livekit, turn, redis, database");
}

console.log("\n==================================================");
console.log(`envReadiness.test.js: ${pass} passed, ${fail} failed`);
console.log("==================================================");
if (fail > 0) process.exit(1);
