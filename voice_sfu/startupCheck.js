// voice_sfu/startupCheck.js
// ==================================================
// PHASE 3, STEP 3.5 — PRODUCTION READINESS / STARTUP VALIDATION (NEW)
// ==================================================
// Pure diagnostics module: reads env vars and checks whether the
// livekit-server-sdk package resolves, and produces a structured report
// of warnings/errors. NEVER throws, NEVER exits the process, and NEVER
// blocks server startup — a misconfigured or absent SFU setup must
// never take down the app that already works fine in mesh mode. This
// mirrors every other voice_sfu module's fail-safe posture (see
// sync.js's `safe()` wrapper, token.js's lazy-require pattern).
//
// Called once at voice_sfu/index.js init time (logs to console, same
// place every other module's startup log line already lives) and again,
// on demand, from GET /api/admin/voice-sfu/readiness so an operator can
// re-check current config without restarting.

const { isConfigured: sfuConfigured } = require("./token.js");
const rollout = require("./rollout.js");

function checkSdkInstalled() {
    try {
        require.resolve("livekit-server-sdk");
        return { installed: true };
    } catch (e) {
        return { installed: false, message: "livekit-server-sdk not installed (npm install livekit-server-sdk)" };
    }
}

function checkEnvVars() {
    const checks = [];
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    checks.push({ name: "LIVEKIT_URL", present: Boolean(url), note: url && !/^wss?:\/\//i.test(url) ? "does not look like a ws(s):// URL — check for a copy/paste error" : undefined });
    checks.push({ name: "LIVEKIT_API_KEY", present: Boolean(key) });
    checks.push({ name: "LIVEKIT_API_SECRET", present: Boolean(secret) });
    const ttl = process.env.LIVEKIT_TOKEN_TTL_SECONDS;
    if (ttl !== undefined && (!Number.isFinite(parseInt(ttl, 10)) || parseInt(ttl, 10) <= 0)) {
        checks.push({ name: "LIVEKIT_TOKEN_TTL_SECONDS", present: true, note: `invalid value "${ttl}" — token.js will silently fall back to its 6h default` });
    }
    return checks;
}

function checkRolloutConfig(baseMode) {
    const warnings = [];
    if (baseMode !== "staged") return warnings;
    const snap = rollout.getStagedConfigSnapshot();
    if (snap.allowlistRoomsCount === 0 && snap.allowlistHostsCount === 0 && snap.percent === 0) {
        warnings.push("VOICE_MODE=staged but none of SFU_STAGE_ALLOWLIST_ROOMS / SFU_STAGE_ALLOWLIST_HOSTS / SFU_STAGE_PERCENT is set — every room will resolve to mesh (equivalent to VOICE_MODE=mesh right now). This is safe (fails closed), but likely not what was intended.");
    }
    if (snap.percent > 0 && snap.percent < 1) {
        warnings.push(`SFU_STAGE_PERCENT=${process.env.SFU_STAGE_PERCENT} rounds down to 0% — no room will get SFU from this knob.`);
    }
    return warnings;
}

// Structured, JSON-serializable, safe to log or return over the admin
// API. `quiet: true` (used by the /readiness route on repeat calls)
// skips the console output — only the initial boot call and any
// operator-triggered re-check that explicitly wants log output print.
function runStartupCheck({ quiet = false } = {}) {
    const baseMode = rollout.rawBaseMode();
    const sdk = checkSdkInstalled();
    const envChecks = checkEnvVars();
    const configured = sfuConfigured();
    const warnings = [];
    const errors = [];

    if (baseMode === "mesh") {
        // Nothing further to check — mesh needs none of the above. Still
        // reports what WOULD be missing if SFU/staged were turned on, as
        // a heads-up for operators planning to move to a later stage.
        if (!configured) warnings.push("VOICE_MODE=mesh (current default) — LiveKit is not configured. This is fine for now; configure LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET before switching VOICE_MODE to \"staged\" or \"sfu\".");
    } else {
        // staged or sfu — LiveKit config genuinely matters for at least
        // some traffic.
        if (!sdk.installed) errors.push(sdk.message);
        if (!configured) {
            const missing = envChecks.filter((c) => !c.present).map((c) => c.name);
            errors.push(`VOICE_MODE=${baseMode} but LiveKit is not fully configured. Missing: ${missing.join(", ") || "unknown"}.`);
        }
        envChecks.forEach((c) => { if (c.note) warnings.push(`${c.name}: ${c.note}`); });
        warnings.push(...checkRolloutConfig(baseMode));
    }

    const report = {
        timestamp: new Date().toISOString(),
        voiceMode: baseMode,
        sfuConfigured: configured,
        sdkInstalled: sdk.installed,
        rolloutConfig: baseMode === "staged" ? rollout.getStagedConfigSnapshot() : undefined,
        warnings,
        errors,
        ready: errors.length === 0
    };

    if (!quiet) {
        if (errors.length) {
            console.error(`[voice_sfu:startup] NOT READY for VOICE_MODE=${baseMode}:`);
            errors.forEach((e) => console.error(`  ✗ ${e}`));
        }
        if (warnings.length) {
            warnings.forEach((w) => console.warn(`[voice_sfu:startup] ⚠ ${w}`));
        }
        if (!errors.length && !warnings.length) {
            console.log(`[voice_sfu:startup] OK — VOICE_MODE=${baseMode}${configured ? ", LiveKit configured" : ""}`);
        }
    }

    return report;
}

module.exports = { runStartupCheck };
