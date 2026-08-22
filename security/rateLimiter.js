// ==================================================
// PHASE 10 — RATE LIMITING (in-memory, no new dependency)
// ==================================================
// A small sliding-window-ish (fixed-window, reset on expiry) limiter keyed
// by IP by default. No `express-rate-limit` package needed — this app has
// no external cache (Redis etc.) configured, so an in-memory Map is the
// honest, working choice for a single-process deployment. If this is ever
// scaled to multiple Node processes/instances behind a load balancer, this
// module's per-process memory won't be shared across them — swap in a
// shared store (Redis) at that point; noted so it isn't forgotten.
//
// Usage:
//   const { rateLimit } = require("./security/rateLimiter");
//   app.post("/api/auth/send-otp", rateLimit({ windowMs: 60_000, max: 5 }), handler);

const buckets = new Map(); // key -> { count, resetAt }

// Periodic sweep so the Map doesn't grow forever from one-off keys
// (attackers rotating IPs, users who only ever hit an endpoint once, etc).
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, 5 * 60 * 1000).unref();

function defaultKey(req) {
    return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

/**
 * @param {number} windowMs - window size in ms
 * @param {number} max - max requests allowed per key per window
 * @param {(req)=>string} [keyFn] - custom key extractor (default: IP)
 * @param {string} [message] - Bengali+English error message
 */
function rateLimit({ windowMs = 60_000, max = 30, keyFn = defaultKey, message } = {}) {
    return (req, res, next) => {
        const key = keyFn(req);
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (bucket.count > max) {
            const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader("Retry-After", String(retryAfterSec));
            return res.status(429).json({
                success: false,
                message: message || `Too many attempts, please try again shortly (retry in ${retryAfterSec}s)`
            });
        }
        next();
    };
}

// Preset limiters for the endpoints Phase 10 targets first (auth + admin
// login are the highest-value ones to protect from brute force / credential
// stuffing / OTP-spam). Reuse these directly, or call rateLimit() with your
// own numbers for any other route.
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 5,
    keyFn: (req) => "otp:" + (req.body?.mobile || defaultKey(req)),
    message: "Too many OTP requests for this number — try again in 10 minutes"
});
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 10,
    keyFn: (req) => "auth:" + (req.body?.mobile || defaultKey(req)),
    message: "Too many attempts — please try again shortly"
});
const adminLoginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 10,
    keyFn: (req) => "admin-login:" + (req.body?.username || defaultKey(req)),
    message: "Too many attempts on Admin login — please try again shortly"
});
// A light general ceiling on /api/* so no single client can hammer the
// server. High enough (per-IP) to never bother a normal user of the app.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

module.exports = { rateLimit, otpLimiter, authLimiter, adminLoginLimiter, apiLimiter };
