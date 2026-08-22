// envReadiness.js
// ==================================================
// PHASE 6 (2026-08-17) — SECRETS/ENV HYGIENE + STARTUP VALIDATION
// ==================================================
// Purely additive, side-effect-free module (same pattern as
// voice_sfu/startupCheck.js and turn-config.js's getStatus()): aggregates
// the "is X configured?" booleans that already exist scattered across the
// codebase (voice_sfu/token.js's isConfigured(), turn-config.js's
// getStatus(), redis/client.js's isEnabled()/getHealth(),
// perf/dbPersistence.js's isEnabled(), security/firebaseAuth.js's
// isFirebaseReady()) into ONE report, for two consumers:
//
//   1. GET /healthz and GET /api/admin/health (server.js) — the exact
//      shape requested by the master fix spec's §28:
//        { server, voiceMode, livekit, turn, redis, database, firebase }
//   2. Startup console logging (server.js, near the top of boot) so an
//      operator sees LIVEKIT/TURN/REDIS/DATABASE/FIREBASE status in one
//      place instead of hunting through scattered log lines.
//
// HARD RULE, enforced by construction, not just convention: every field
// this module returns is either a boolean, an enum string, or a count —
// never a URL, key, secret, or token. Nothing in this file ever reads
// LIVEKIT_API_SECRET/CLOUDFLARE_TURN_API_TOKEN/etc. for its VALUE, only
// checks `Boolean(process.env.X)` for presence. This module itself has
// zero new knowledge of any secret — it only asks other modules "are you
// configured?" and relays their yes/no.

function safeRequire(path) {
    try { return require(path); } catch (e) { return null; }
}

function checkLiveKit() {
    const sfuToken = safeRequire("./voice_sfu/token.js");
    const url = Boolean(process.env.LIVEKIT_URL);
    const key = Boolean(process.env.LIVEKIT_API_KEY);
    const secret = Boolean(process.env.LIVEKIT_API_SECRET);
    const configured = sfuToken ? Boolean(sfuToken.isConfigured && sfuToken.isConfigured()) : (url && key && secret);
    return {
        configured,
        status: configured ? "configured" : "missing"
    };
}

function checkTurn() {
    const turnConfig = safeRequire("./turn-config.js");
    if (turnConfig && typeof turnConfig.getStatus === "function") {
        const s = turnConfig.getStatus();
        return { configured: s.configured, status: s.configured ? s.mode : "missing" };
    }
    return { configured: false, status: "missing" };
}

function checkRedis() {
    const redisClient = safeRequire("./redis/client.js");
    if (!redisClient) return { configured: false, status: "disabled" };
    const enabled = typeof redisClient.isEnabled === "function" ? redisClient.isEnabled() : false;
    if (!enabled) return { configured: false, status: "disabled" };
    // Connection-level detail (allReady) is intentionally NOT surfaced on
    // the public /healthz — only on the admin-authenticated variant — to
    // avoid leaking infrastructure topology to unauthenticated callers.
    let allReady;
    try { allReady = redisClient.getHealth && redisClient.getHealth().allReady; } catch (e) { allReady = undefined; }
    return { configured: true, status: allReady === false ? "degraded" : "connected", allReady };
}

function checkDatabase() {
    const dbPersistence = safeRequire("./perf/dbPersistence.js");
    const enabled = dbPersistence && typeof dbPersistence.isEnabled === "function" ? dbPersistence.isEnabled() : false;
    return { configured: enabled, status: enabled ? "postgresql" : "json" };
}

function checkFirebase() {
    const firebaseAuth = safeRequire("./security/firebaseAuth.js");
    const ready = firebaseAuth && typeof firebaseAuth.isFirebaseReady === "function" ? firebaseAuth.isFirebaseReady() : false;
    return { configured: ready, status: ready ? "configured" : "disabled" };
}

// Full report — used by /api/admin/health (authenticated) and startup
// console logging. Safe to log or return as JSON: contains no secrets.
function getReadinessReport() {
    const voiceMode = process.env.VOICE_MODE || "mesh";
    const livekit = checkLiveKit();
    const turn = checkTurn();
    const redis = checkRedis();
    const database = checkDatabase();
    const firebase = checkFirebase();
    return {
        timestamp: new Date().toISOString(),
        server: "ok",
        voiceMode,
        livekit: livekit.status,
        turn: turn.status,
        redis: redis.status,
        database: database.status,
        firebase: firebase.status
    };
}

// Reduced shape for the PUBLIC /healthz route — no operator infra detail
// beyond what the spec's §28 example explicitly shows.
function getPublicHealth() {
    const r = getReadinessReport();
    return { server: r.server, voiceMode: r.voiceMode, livekit: r.livekit, turn: r.turn, redis: r.redis, database: r.database };
}

// PHASE 6 fail-fast (§29): "If production mode is enabled and required
// voice credentials are missing, fail fast rather than silently falling
// back to mesh." Scoped narrowly on purpose — this only fires when an
// operator has EXPLICITLY asked for VOICE_MODE=sfu (or staged, which can
// route real traffic to SFU) in NODE_ENV=production and LiveKit isn't
// actually configured. It never fires for VOICE_MODE=mesh (an explicit,
// valid choice, not a silent fallback) and never fires outside production
// (so local/Termux testing with mesh-by-default never gets blocked).
// Throws (caller decides whether to catch or let the process exit) rather
// than calling process.exit() itself, so tests can assert on it without
// killing the test runner.
function assertProductionVoiceReadiness() {
    const isProd = process.env.NODE_ENV === "production";
    const mode = process.env.VOICE_MODE || "mesh";
    if (!isProd || mode === "mesh") return { ok: true };
    const livekit = checkLiveKit();
    if (!livekit.configured) {
        const err = new Error(
            `FATAL: NODE_ENV=production and VOICE_MODE=${mode}, but LiveKit is not configured ` +
            `(missing one or more of LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET). ` +
            `Refusing to silently fall back to mesh in production — set VOICE_MODE=mesh explicitly ` +
            `if that's actually intended, or configure LiveKit before starting.`
        );
        err.code = "VOICE_SFU_NOT_CONFIGURED";
        throw err;
    }
    return { ok: true };
}

module.exports = { getReadinessReport, getPublicHealth, assertProductionVoiceReadiness, checkLiveKit, checkTurn, checkRedis, checkDatabase, checkFirebase };
