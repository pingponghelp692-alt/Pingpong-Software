// ==================================================
// MODULE 5.2 — ENV-DRIVEN CORS (shared by HTTP + Socket.IO)
// ==================================================
// Previously: `app.use(cors())` with no options at all — every origin was
// allowed, unconditionally, on every HTTP route, and Socket.IO had no
// `cors` block either (which is only a non-issue as long as the app is
// only ever loaded same-origin; it does not restrict anything on its own).
//
// This module does NOT hard-code a production domain — nothing in the
// supplied project (env files, config, docs) states what that domain
// actually is, and guessing one would be worse than not guessing: a wrong
// hard-coded origin silently locks out the real production frontend the
// day it's deployed. Instead:
//
//   - Set CORS_ORIGINS in .env to a comma-separated allowlist, e.g.
//       CORS_ORIGINS=https://pingpong.example.com,https://admin.pingpong.example.com
//     Exact scheme+host+port match, same as how browsers send Origin.
//
//   - If CORS_ORIGINS is not set: requests with NO Origin header (same-
//     origin page loads, and — importantly — the app's own mobile
//     WebView/native HTTP client and server-to-server calls, none of which
//     send an Origin header at all) are always allowed; nothing about the
//     existing mobile app or same-origin web flow changes. Only actual
//     cross-origin BROWSER requests are affected, and even then only
//     localhost/127.0.0.1 (any port) is allowed by default, which is
//     exactly the shape of a local dev setup (frontend on one port, API on
//     another). Any other cross-origin browser request is rejected until
//     CORS_ORIGINS is explicitly configured — replacing the previous
//     fully-open `cors()` with a safe-by-default posture instead of an
//     unbounded one, without needing to know the real prod domain today.
//
// Exported as pure functions specifically so they can be unit-tested
// without spinning up a real HTTP server or a real Socket.IO instance —
// see test/corsConfig.test.js.

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * @param {string|undefined} envValue - raw CORS_ORIGINS env value
 * @returns {Set<string>|null} null = "not configured" (env unset/empty)
 */
function parseAllowlist(envValue) {
    if (!envValue || !String(envValue).trim()) return null;
    const set = new Set(
        String(envValue)
            .split(",")
            .map((s) => s.trim().replace(/\/+$/, "")) // trim + drop trailing slash
            .filter(Boolean)
    );
    return set.size ? set : null;
}

/**
 * @param {string|undefined} origin - the request's Origin header (undefined if absent)
 * @param {Set<string>|null} allowlist - result of parseAllowlist(), or null if unconfigured
 * @returns {boolean}
 */
function isOriginAllowed(origin, allowlist) {
    // No Origin header at all: not a cross-origin browser request — this is
    // a same-origin page load, a non-browser HTTP client (the mobile app's
    // native networking layer, curl, server-to-server calls), all of which
    // never send this header. Always allow; CORS exists to police
    // cross-origin *browser* requests, not these.
    if (!origin) return true;
    if (allowlist) return allowlist.has(origin.replace(/\/+$/, ""));
    // CORS_ORIGINS not configured — safe default: only localhost dev origins.
    return LOCALHOST_ORIGIN_RE.test(origin);
}

// Reads live each call (cheap; a handful of string ops) so a changed env
// var takes effect without extra plumbing, and so tests can exercise both
// configured/unconfigured states without module-cache gymnastics.
function getAllowlist() {
    return parseAllowlist(process.env.CORS_ORIGINS);
}

// Shared origin-check callback shape both `cors` (Express) and Socket.IO's
// `cors` option expect: (origin, callback) => callback(err, allow).
// Never pass an Error here — an unrecognized origin should just be denied
// (no CORS headers / handshake refused), not thrown as a 500.
function corsOriginCallback(origin, callback) {
    callback(null, isOriginAllowed(origin, getAllowlist()));
}

// Express `cors()` options — no credentials (this app authenticates via an
// opaque header/body token, never cookies, so credentialed CORS is neither
// needed nor enabled).
const httpCorsOptions = {
    origin: corsOriginCallback,
    credentials: false
};

// Socket.IO's own `cors` option, same allowlist logic so HTTP and
// WebSocket/polling transport behavior can never drift apart.
const socketIoCorsOptions = {
    origin: corsOriginCallback,
    methods: ["GET", "POST"],
    credentials: false
};

module.exports = {
    parseAllowlist,
    isOriginAllowed,
    getAllowlist,
    corsOriginCallback,
    httpCorsOptions,
    socketIoCorsOptions
};
