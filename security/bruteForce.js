// ==================================================
// PHASE 10 — BRUTE-FORCE PROTECTION (progressive lockout)
// ==================================================
// Separate from rateLimiter.js on purpose: rate limiting caps *request
// rate* (blunt, resets on a timer regardless of success/failure); this
// module tracks *consecutive failed auth attempts per identifier* (mobile
// number, or admin username) and locks that specific identifier out for a
// growing cooldown — so a slow attacker who paces requests just under the
// rate limit still gets stopped after N wrong passwords. Use both together
// on login endpoints.
//
// Lockout doubles each time: 5 fails -> 1 min, then 2 min, 4 min... capped
// at 30 min. A successful login clears the identifier's record entirely.

const attempts = new Map(); // identifier -> { fails, lockedUntil, cooldownMs }

const THRESHOLD = 5; // fails before first lockout
const BASE_COOLDOWN_MS = 60 * 1000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of attempts) {
        if ((!rec.lockedUntil || rec.lockedUntil <= now) && now - (rec.lastAttempt || 0) > 60 * 60 * 1000) {
            attempts.delete(id); // stale, no activity in an hour — forget it
        }
    }
}, 10 * 60 * 1000).unref();

function normalize(identifier) {
    return String(identifier || "unknown").toLowerCase();
}

/** Returns { locked: boolean, retryAfterSec?: number } */
function checkLocked(identifier) {
    const rec = attempts.get(normalize(identifier));
    if (!rec || !rec.lockedUntil) return { locked: false };
    const now = Date.now();
    if (rec.lockedUntil <= now) return { locked: false };
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
}

function recordFailure(identifier) {
    const id = normalize(identifier);
    const rec = attempts.get(id) || { fails: 0, lockedUntil: 0, cooldownMs: BASE_COOLDOWN_MS };
    rec.fails += 1;
    rec.lastAttempt = Date.now();
    if (rec.fails >= THRESHOLD) {
        rec.lockedUntil = Date.now() + rec.cooldownMs;
        rec.cooldownMs = Math.min(rec.cooldownMs * 2, MAX_COOLDOWN_MS);
        rec.fails = 0; // count resets for the next lockout cycle
    }
    attempts.set(id, rec);
}

function recordSuccess(identifier) {
    attempts.delete(normalize(identifier));
}

module.exports = { checkLocked, recordFailure, recordSuccess };
