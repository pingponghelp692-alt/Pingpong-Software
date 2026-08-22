// ai/ai-security.js
// Lightweight, dependency-free rate limiting. Tracks recent hit timestamps
// per key (e.g. "chat:<userId>" or "room:<roomId>:<userId>") in memory and
// flags a key once it crosses a threshold within a time window.
//
// NOTE ON SCOPE: things like "Modified APK / Root Detection / Emulator
// Detection / Play Integrity" in the original spec must run on the mobile
// app's native (Android/Kotlin or Flutter) side — a Node backend never sees
// the device itself, so those specific checks can't live here. This module
// covers the parts a backend genuinely can enforce: request/message rate
// abuse, wallet-manipulation attempts (see server.js — coins are always
// server-authoritative already), and replay-style spam.
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");

const hits = new Map(); // key -> [timestamps]

function isRateLimited(key, { windowMs = 10000, max = 8 } = {}) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    const limited = arr.length > max;
    if (limited) {
        analytics.increment("totalRateLimitHits");
        logger.log({ module: "ai-security", action: "rate-limit", result: "flagged", key, count: arr.length, windowMs, max });
    }
    return limited;
}

// Periodic cleanup so this Map doesn't grow forever for users who came and left.
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of hits.entries()) {
        const fresh = arr.filter((t) => now - t < 60000);
        if (fresh.length === 0) hits.delete(key); else hits.set(key, fresh);
    }
}, 60000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { isRateLimited };
