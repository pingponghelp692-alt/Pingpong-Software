// ==================================================
// PHASE 10 — ADMIN SESSION MANAGEMENT (additive)
// ==================================================
// server.js's existing `adminSessions` Map (token -> admin account id) has
// no expiry — a token, once issued, was valid forever until server
// restart. This module adds expiry WITHOUT changing that Map's shape (so
// every existing `adminSessions.get(token)` call site in server.js keeps
// working untouched) — it just tracks its own parallel
// token -> lastActiveAt timestamp, and server.js calls touch()/isExpired()
// around the existing lookups.
//
// Policy: idle timeout (no request in IDLE_TIMEOUT_MS) AND an absolute max
// session lifetime (ABSOLUTE_TIMEOUT_MS), whichever comes first. Every
// authenticated admin request via requireAdmin() should call touch(token)
// on success — that both checks expiry and refreshes the idle clock.

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min inactivity
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours max, even if active

const sessionMeta = new Map(); // token -> { createdAt, lastActiveAt }

// Phase 11: an admin who closes their browser tab without logging out
// leaves their token in server.js's adminSessions Map forever (nothing
// ever removes it — requireAdmin only cleans it up if that SAME token is
// used again after expiry). Small leak, but unbounded over a long-running
// server with many admin logins. Optional hook so server.js can clean its
// own Map in step with this module's own periodic sweep, without this
// module needing to know adminSessions exists.
let onExpireCallback = null;
function setOnExpire(fn) { onExpireCallback = fn; }

function start(token) {
    const now = Date.now();
    sessionMeta.set(token, { createdAt: now, lastActiveAt: now });
}

/** Call on every authenticated request. Returns true if session is still valid (and refreshes idle clock); false if expired. */
function touch(token) {
    const meta = sessionMeta.get(token);
    if (!meta) return false; // never started via start() — treat as unknown/expired
    const now = Date.now();
    if (now - meta.lastActiveAt > IDLE_TIMEOUT_MS) return false;
    if (now - meta.createdAt > ABSOLUTE_TIMEOUT_MS) return false;
    meta.lastActiveAt = now;
    return true;
}

function end(token) {
    sessionMeta.delete(token);
}

setInterval(() => {
    const now = Date.now();
    for (const [token, meta] of sessionMeta) {
        if (now - meta.lastActiveAt > IDLE_TIMEOUT_MS || now - meta.createdAt > ABSOLUTE_TIMEOUT_MS) {
            sessionMeta.delete(token);
            if (onExpireCallback) onExpireCallback(token);
        }
    }
}, 10 * 60 * 1000).unref();

module.exports = { start, touch, end, setOnExpire, IDLE_TIMEOUT_MS, ABSOLUTE_TIMEOUT_MS };
