// ==================================================
// PHASE 14 — USER SESSION TOKEN INFRASTRUCTURE (enforced on protected routes)
// ==================================================
// Mirrors the pattern already used for admin sessions (security/session.js)
// but for regular users. Until now, every non-admin endpoint trusted a
// client-supplied `mobile` or `userId` in the request body as if it were
// proof of identity — anyone could act as any user by just putting a
// different id in the body. This module issues an opaque, unguessable
// token at successful login (OTP verify / password login) and lets
// endpoints resolve the *real* logged-in mobile from that token instead of
// trusting the body.
//
// The middleware is wired into protected user endpoints. Client-supplied
// mobile/userId values are not accepted as identity when this guard is used.
//
// Policy mirrors admin sessions: idle timeout + absolute max lifetime,
// whichever comes first. A successful validate() call refreshes the idle
// clock ("refresh on use" — no separate refresh endpoint needed for now).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Redis session mirror (Phase 2B, see redis/sessionStore.js) ----------
// Additive only: the in-memory `tokens`/`tokensByMobile` Maps + tokens.json
// on disk (below) remain the sole source of truth for every auth decision
// in this file — requireUserAuth() never reads from Redis. Every call
// below is fire-and-forget (not awaited, errors swallowed) so a slow or
// unavailable Redis can never add latency to login/logout or cause a
// 401/500 that wasn't already going to happen. If redis/sessionStore.js
// itself is missing/broken, the whole mirror silently disables — this
// file works exactly as before Phase 2B either way.
let sessionStore = null;
let redisClient = null;
try {
    sessionStore = require("../redis/sessionStore.js");
    redisClient = require("../redis/client.js"); // same module sessionStore.js itself uses internally; required here too only for its synchronous isEnabled() gate, see validateTokenCrossInstance() below
} catch (e) {
    console.warn(`[userAuth] Redis session mirror unavailable, continuing without it: ${e.message}`);
}
function mirrorSession(fn) {
    if (!sessionStore) return;
    try {
        const result = fn(sessionStore);
        if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (e) {
        // Never let a mirror-layer bug touch the real auth path.
    }
}

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days inactivity
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days max, even if active

// token -> { mobile, createdAt, lastActiveAt }
const tokens = new Map();
// mobile -> Set<token>  (lets us revoke/list all sessions for one user, e.g. on ban or logout-everywhere)
const tokensByMobile = new Map();

// AUDIT FIX (2026-07-27, "login randomly resets") — Tokens used to live
// ONLY in this in-memory Map. Every server restart — a deploy, a crash, or
// just PM2's own autorestart on a memory-limit hit (see ecosystem.config.js,
// autorestart:true) — wiped every logged-in user's token instantly, even
// though their account/password/cached profile were all still fine. The
// client only finds out on the next authenticated action (send gift, wallet
// exchange, etc.), gets a 401 forceLogout, and is bounced to the login
// screen — which reads to the user as "my login randomly reset," with no
// visible cause. Fix: persist tokens to disk (same debounced/atomic pattern
// as users.json/rooms.json, see perf/writeQueue.js) and reload them on
// boot, so a restart no longer force-logs-out anyone whose token hadn't
// actually expired.
const TOKENS_FILE = path.join(__dirname, "..", "data", "tokens.json");
let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeTokensNow();
    }, 250);
    saveTimer.unref();
}
function writeTokensNow() {
    try {
        const dir = path.dirname(TOKENS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const serializable = {};
        for (const [token, rec] of tokens) serializable[token] = rec;
        const tmpFile = TOKENS_FILE + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(serializable));
        fs.renameSync(tmpFile, TOKENS_FILE);
    } catch (err) {
        console.error(`❌ Failed to persist auth tokens to ${TOKENS_FILE}:`, err.message);
    }
}
function loadTokensFromDisk() {
    try {
        if (!fs.existsSync(TOKENS_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
        const now = Date.now();
        let restored = 0;
        for (const [token, rec] of Object.entries(raw)) {
            if (!rec || !rec.mobile) continue;
            // Don't resurrect anything that had already expired before the restart.
            if (now - rec.lastActiveAt > IDLE_TIMEOUT_MS || now - rec.createdAt > ABSOLUTE_TIMEOUT_MS) continue;
            tokens.set(token, rec);
            if (!tokensByMobile.has(rec.mobile)) tokensByMobile.set(rec.mobile, new Set());
            tokensByMobile.get(rec.mobile).add(token);
            restored++;
        }
        console.log(`🔑 Restored ${restored} active login session(s) from ${TOKENS_FILE}`);
    } catch (err) {
        console.error(`❌ Failed to load persisted auth tokens from ${TOKENS_FILE} — starting with no restored sessions:`, err.message);
    }
}
loadTokensFromDisk();
process.on("SIGINT", () => { writeTokensNow(); });
process.on("SIGTERM", () => { writeTokensNow(); });

function issueToken(mobile) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    tokens.set(token, { mobile, createdAt: now, lastActiveAt: now });
    if (!tokensByMobile.has(mobile)) tokensByMobile.set(mobile, new Set());
    tokensByMobile.get(mobile).add(token);
    // BUG FIX (login-lost-on-redeploy/restart, 2026-07-29): this used to go
    // through the same 250ms-debounced scheduleSave() as every other write
    // here. That's the right tradeoff for high-frequency idle-clock
    // refreshes (validateToken(), below), but a freshly issued login token
    // is low-frequency and high-value — if the process is killed hard
    // (e.g. a manual redeploy/restart script that doesn't send SIGTERM/
    // SIGINT, which is common outside a process manager) inside that
    // 250ms window, the token is lost even though the person just logged
    // in successfully, and they land back on the login screen on the very
    // next request. Writing synchronously here removes that window
    // entirely — the token is durably on disk before login even responds
    // to the client. Login is infrequent enough that this costs nothing
    // in practice.
    writeTokensNow();
    mirrorSession((s) => s.createSession(mobile, token));
    return token;
}

/** Returns the mobile for a valid token, refreshing its idle clock — or null if missing/expired. */
function validateToken(token) {
    if (!token) return null;
    const rec = tokens.get(token);
    if (!rec) return null;
    const now = Date.now();
    if (now - rec.lastActiveAt > IDLE_TIMEOUT_MS || now - rec.createdAt > ABSOLUTE_TIMEOUT_MS) {
        revokeToken(token);
        return null;
    }
    rec.lastActiveAt = now;
    // Idle-clock refresh is high-frequency (every authenticated request) and
    // low-value to persist on every single call — the worst case if the
    // process dies before this lands on disk is a session's idle timer
    // rewinds slightly, not that it's lost. Still debounced/coalesced like
    // every other write in this codebase, just intentionally not urgent.
    scheduleSave();
    mirrorSession((s) => s.touchSession(token));
    return rec.mobile;
}

// ---------- Gap #1: Redis-authoritative cross-instance session read (additive) ----------
// Everything above (issueToken/validateToken/revokeToken) is unchanged and
// remains the fast, synchronous, local-Map source of truth for a token
// this instance itself issued or has already seen — that hot path is not
// touched. This function ONLY adds a fallback for the case the local Maps
// genuinely cannot answer: a token issued by a DIFFERENT instance in the
// cluster (e.g. login landed on instance A, this request landed on
// instance B behind a non-sticky load balancer). Without this, instance B
// would wrongly 401 a perfectly valid session — which is the actual bug
// this closes.
//
// Ordering matters for both correctness and for not regressing existing
// callers/tests: the local synchronous check runs FIRST and returns
// immediately (before any `await`) on a hit, so every existing
// single-instance call site — including test/authHardening.test.js,
// which only ever validates tokens issued in the same process — observes
// byte-for-byte the same synchronous timing as before. The Redis fallback
// is also skipped synchronously (no `await` ever reached) whenever
// redisClient.isEnabled() is false, i.e. Redis isn't configured — the
// default in every environment this project has been tested in so far
// (see FINAL_INTEGRATION_REPORT.md §14). Only a real local-miss AND a
// real enabled Redis connection ever takes the async path.
//
// On a genuine cross-instance hit, the local Maps are hydrated from the
// Redis record (self-healing cache) so every subsequent request with the
// same token on THIS instance takes the fast local path from then on.
async function validateTokenCrossInstance(token) {
    if (!token) return null;
    const local = validateToken(token); // unchanged fast path
    if (local) return local;
    if (!sessionStore || !redisClient || !redisClient.isEnabled()) return null; // fully synchronous — no await reached when Redis isn't configured
    let session = null;
    try {
        session = await sessionStore.validateSession(token);
    } catch (e) {
        return null; // never let a Redis hiccup surface as an auth error
    }
    if (!session || !session.userId) return null;
    const mobile = session.userId; // sessionStore's "userId" param is this app's mobile — see issueToken()'s mirrorSession call below
    const now = Date.now();
    const createdAt = session.createdAt ? new Date(session.createdAt).getTime() : now;
    // Same absolute-lifetime rule as the local path — don't resurrect a
    // session Redis's own TTL hasn't expired yet but this app's own
    // ABSOLUTE_TIMEOUT_MS says is too old.
    if (now - createdAt > ABSOLUTE_TIMEOUT_MS) return null;
    tokens.set(token, { mobile, createdAt, lastActiveAt: now });
    if (!tokensByMobile.has(mobile)) tokensByMobile.set(mobile, new Set());
    tokensByMobile.get(mobile).add(token);
    scheduleSave(); // best-effort local persistence, same debounced pattern as every other write here
    mirrorSession((s) => s.touchSession(token)); // refresh this session's Redis-side sliding TTL too, same as a normal validateToken() touch
    return mobile;
}

function revokeToken(token) {
    const rec = tokens.get(token);
    if (!rec) return;
    tokens.delete(token);
    const set = tokensByMobile.get(rec.mobile);
    if (set) {
        set.delete(token);
        if (set.size === 0) tokensByMobile.delete(rec.mobile);
    }
    scheduleSave();
    mirrorSession((s) => s.revokeSession(token));
}

/** Revoke every token for a mobile — e.g. on ban, password change, or "logout everywhere". */
function revokeAllForMobile(mobile) {
    const set = tokensByMobile.get(mobile);
    if (!set) return;
    for (const token of set) tokens.delete(token);
    tokensByMobile.delete(mobile);
    scheduleSave();
    mirrorSession((s) => s.revokeAllSessions(mobile));
}

// Express middleware: resolves the authenticated mobile onto req.authedMobile.
// Accepts the token via `Authorization: Bearer <token>` header (preferred)
// or `req.body.authToken` (fallback, for callers that can't easily set
// headers, e.g. some upload flows). Does NOT trust req.body.mobile/userId.
// GAP #1 NOTE: on a LOCAL hit this is 100% unchanged — same synchronous
// validateToken() call, same synchronous next()/401 response, so every
// existing caller (including test/authHardening.test.js, which only ever
// validates tokens issued in the same process) sees byte-for-byte the
// same timing as before. IMPORTANT: this local check is deliberately kept
// OUTSIDE any `async`/`await`, because `await`-ing even an
// already-resolved Promise still defers to the next microtask — routing
// every request through one unconditional `await` would have silently
// turned this synchronous middleware asynchronous for 100% of requests,
// not just the cross-instance-miss case. Only a genuine LOCAL MISS falls
// through to the Redis fallback below; when Redis isn't enabled that
// fallback also resolves synchronously (no Promise ever created), and
// only a real local-miss + Redis-enabled cluster deployment actually
// takes the async `.then()` path.
function requireUserAuth(req, res, next) {
    const header = req.headers["authorization"] || "";
    const bearerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const token = bearerToken || req.body?.authToken || req.query?.authToken;

    const localMobile = validateToken(token); // unchanged fast path
    if (localMobile) {
        req.authedMobile = localMobile;
        return next();
    }

    function reject() {
        // TEMP DIAGNOSTIC (refresh-logout trace, 2026-07-29) — shows exactly
        // why any given authenticated call succeeded or failed: no token
        // sent at all (client-side problem) vs. a token that was sent but
        // the server considers invalid/expired (real server-side problem).
        console.log(`🔍 [AUTH-CHECK] ${req.method} ${req.path} -> 401 (token ${token ? "present but invalid/expired" : "MISSING from request"})`);
        res.status(401).json({ success: false, message: "Login session expired — please log in again", forceLogout: true });
    }

    if (!sessionStore || !redisClient || !redisClient.isEnabled()) {
        return reject(); // synchronous — identical to pre-Gap#1 behavior
    }

    // Genuine cross-instance case only: local miss, Redis actually
    // enabled. See validateTokenCrossInstance()'s header for the full
    // rationale and the local-cache hydration it does on a hit.
    validateTokenCrossInstance(token).then((mobile) => {
        if (!mobile) return reject();
        req.authedMobile = mobile;
        next();
    }).catch(() => reject()); // never let a Redis hiccup bypass or crash auth
}

setInterval(() => {
    const now = Date.now();
    for (const [token, rec] of tokens) {
        if (now - rec.lastActiveAt > IDLE_TIMEOUT_MS || now - rec.createdAt > ABSOLUTE_TIMEOUT_MS) {
            revokeToken(token); // already schedules a save
        }
    }
}, 60 * 60 * 1000).unref();

module.exports = { issueToken, validateToken, validateTokenCrossInstance, revokeToken, revokeAllForMobile, requireUserAuth };
