// redis/sessionStore.js
// ==================================================
// PHASE 2A — SHARED SESSION MANAGEMENT
// ==================================================
// STATUS: standalone, ready-to-integrate infrastructure. NOT wired into
// the existing login flow in this delivery, because that flow lives in
// `userAuth.js` (issueToken/verifyToken), which was not part of the
// Phase 1/2A file set. Wiring it in is a small, deliberate change to
// that file — see "HOW TO ACTIVATE" at the bottom of this header —
// rather than something this module should guess at and risk breaking
// the current authToken behavior for every logged-in user.
//
// Until that integration happens, calling these functions is entirely
// additive/no-op-safe: nothing in server.js currently calls them, so
// existing login/session behavior (whatever userAuth.js does today) is
// completely unaffected by this file's presence.
//
// DATA MODEL
//   session:token:{token}   JSON: { userId, deviceId, deviceLabel,
//                           createdAt, expiresAt, lastSeenAt }
//   session:user:{userId}   Redis SET of that user's active tokens
//                           (this is what makes multi-device handling
//                           and duplicate-session detection possible —
//                           without it you can only ever look up one
//                           token at a time, never "everything this
//                           user is currently logged in on")
//
// FEATURES
//   createSession        issue + store a new session for a user+device
//   validateSession       check a token is known and not expired
//   touchSession           refresh lastSeenAt + sliding TTL
//   revokeSession           log out one device/token
//   revokeAllSessions        log out every device for a user
//   listSessions              multi-device: see all active sessions
//   findDuplicateDeviceSession   duplicate-session detection: is this
//                              exact device already logged in under a
//                              different token?
//
// HOW TO ACTIVATE (future step, needs userAuth.js):
//   1. In userAuth.issueToken(mobile), after generating the token, call
//      `sessionStore.createSession(mobile, token, { deviceId })`.
//   2. In whatever middleware currently calls userAuth.verifyToken(),
//      also call `sessionStore.touchSession(token)` so lastSeenAt stays
//      fresh (sliding expiration) — or `validateSession(token)` if you
//      want Redis to be an additional check, not just a mirror.
//   3. On logout, call `sessionStore.revokeSession(token)`.
//   None of this is required for Phase 2A to be complete — it's the
//   hook point for whenever that follow-up is done.

const client = require("./client.js");

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days, sliding

function tokenKey(token) {
    return client.prefixed(`session:token:${token}`);
}
function userSetKey(userId) {
    return client.prefixed(`session:user:${userId}`);
}

async function createSession(userId, token, { deviceId = null, deviceLabel = null, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    const now = new Date();
    const session = {
        userId,
        deviceId,
        deviceLabel,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        lastSeenAt: now.toISOString(),
    };
    try {
        const multi = conn.multi();
        multi.set(tokenKey(token), JSON.stringify(session), "EX", ttlSeconds);
        multi.sadd(userSetKey(userId), token);
        multi.expire(userSetKey(userId), ttlSeconds);
        await multi.exec();
        return true;
    } catch (e) {
        console.warn(`[redis/sessionStore] createSession failed: ${e.message}`);
        return false;
    }
}

async function validateSession(token) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    try {
        const raw = await conn.get(tokenKey(token));
        return raw ? JSON.parse(raw) : null; // absent = expired-or-unknown
    } catch (e) {
        console.warn(`[redis/sessionStore] validateSession failed: ${e.message}`);
        return null;
    }
}

async function touchSession(token, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        const raw = await conn.get(tokenKey(token));
        if (!raw) return false;
        const session = JSON.parse(raw);
        session.lastSeenAt = new Date().toISOString();
        const multi = conn.multi();
        multi.set(tokenKey(token), JSON.stringify(session), "EX", ttlSeconds);
        multi.expire(userSetKey(session.userId), ttlSeconds);
        await multi.exec();
        return true;
    } catch (e) {
        console.warn(`[redis/sessionStore] touchSession failed: ${e.message}`);
        return false;
    }
}

async function revokeSession(token) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        const raw = await conn.get(tokenKey(token));
        const userId = raw ? JSON.parse(raw).userId : null;
        const multi = conn.multi();
        multi.del(tokenKey(token));
        if (userId) multi.srem(userSetKey(userId), token);
        await multi.exec();
        return true;
    } catch (e) {
        console.warn(`[redis/sessionStore] revokeSession failed: ${e.message}`);
        return false;
    }
}

async function revokeAllSessions(userId) {
    if (!client.isEnabled()) return 0;
    const conn = client.getConnection();
    if (!conn) return 0;
    try {
        const tokens = await conn.smembers(userSetKey(userId));
        if (!tokens.length) return 0;
        const multi = conn.multi();
        tokens.forEach((t) => multi.del(tokenKey(t)));
        multi.del(userSetKey(userId));
        await multi.exec();
        return tokens.length;
    } catch (e) {
        console.warn(`[redis/sessionStore] revokeAllSessions failed: ${e.message}`);
        return 0;
    }
}

// Multi-device handling: every active session for a user.
async function listSessions(userId) {
    if (!client.isEnabled()) return [];
    const conn = client.getConnection();
    if (!conn) return [];
    try {
        const tokens = await conn.smembers(userSetKey(userId));
        if (!tokens.length) return [];
        const raws = await conn.mget(tokens.map(tokenKey));
        return tokens
            .map((token, i) => (raws[i] ? { token, ...JSON.parse(raws[i]) } : null))
            .filter(Boolean);
    } catch (e) {
        console.warn(`[redis/sessionStore] listSessions failed: ${e.message}`);
        return [];
    }
}

// Duplicate-session detection: does this user already have an active
// session on this exact deviceId, under a *different* token? Useful for
// "you're already logged in on this device" flows without forcing a
// single-session-per-user policy.
async function findDuplicateDeviceSession(userId, deviceId, excludeToken = null) {
    if (!deviceId) return null;
    const sessions = await listSessions(userId);
    return sessions.find((s) => s.deviceId === deviceId && s.token !== excludeToken) || null;
}

module.exports = {
    createSession,
    validateSession,
    touchSession,
    revokeSession,
    revokeAllSessions,
    listSessions,
    findDuplicateDeviceSession,
    DEFAULT_TTL_SECONDS,
};
