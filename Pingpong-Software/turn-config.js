// turn-config.js
// ==================================================
// PHASE 1 (Tier A) — TURN SERVER INTEGRATION
// ==================================================
// Purely additive module, same init-function pattern as every other
// feature module in this codebase (banManagement.js, analyticsHub.js,
// etc.) — no global state, no side effects at require-time beyond
// reading env vars once.
//
// WHAT THIS REPLACES: callSignaling.js used to build its own ICE server
// list inline (buildIceServers()). That logic is moved here unchanged in
// behavior — same env vars (STUN_URL/TURN_URL/TURN_USERNAME/
// TURN_CREDENTIAL), same validation, same {success, iceServers} response
// shape — so /api/calls/ice-servers (used by both the private-call flow
// AND every room voice connection, see public/app.js getIceServers())
// keeps working exactly as before with zero client changes required.
//
// WHAT THIS ADDS: an optional second mode — short-lived, per-request TURN
// credentials generated with the standard coturn/rfc5766-turn-server
// "REST API" long-term-credential mechanism (HMAC-SHA1 over
// `${expiryTimestamp}:${userId}`, using a shared secret configured once
// on both this server and the TURN server, never sent to the client).
// This is how every production voice/video product does TURN auth: it
// avoids a single hardcoded TURN_USERNAME/TURN_CREDENTIAL pair that (a)
// never expires and (b) is identical for every user, which is a real
// abuse risk once TURN_URL is public (anyone who sniffs one client's ICE
// config can relay unlimited bandwidth through your TURN server forever).
//
// Backward compatible: if TURN_SECRET is not set, this falls back to the
// exact static-credential behavior that already existed. Operators can
// adopt dynamic credentials by setting TURN_SECRET + TURN_REALM whenever
// they're ready — no code change, no breaking change, no forced migration.
//
// FUTURE-COMPATIBILITY NOTE (state-migration / Tier B): this module is
// stateless — every call to getIceServers(userId) is pure (env + current
// time in, ICE server list out). It reads no in-memory room/user state,
// so it needs zero changes when the app moves to Redis/multi-instance —
// any instance behind a load balancer computes the same correct answer
// independently. This is intentional: TURN credentialing must be
// stateless in a horizontally-scaled deployment, since there is no
// guarantee the same instance serves a client's later requests.

const crypto = require("crypto");

function isValidStunOrTurnUrl(url, kind) {
    if (typeof url !== "string" || !url.trim()) return false;
    const prefixes = kind === "stun" ? ["stun:", "stuns:"] : ["turn:", "turns:"];
    return prefixes.some((p) => url.trim().toLowerCase().startsWith(p));
}

// One or more TURN URLs, comma-separated in TURN_URL (e.g.
// "turn:turn1.example.com:3478,turn:turn2.example.com:3478") so an
// operator can point at more than one TURN server (different regions,
// or a UDP + TCP/TLS pair for networks that block UDP) without code
// changes. A single URL with no comma works exactly as before.
function parseTurnUrls(raw) {
    if (!raw) return [];
    return raw.split(",").map((u) => u.trim()).filter((u) => isValidStunOrTurnUrl(u, "turn"));
}

function buildStunEntry() {
    const rawStun = process.env.STUN_URL;
    if (rawStun && isValidStunOrTurnUrl(rawStun, "stun")) {
        console.log("[turn-config] STUN loaded (env)");
        return { urls: rawStun.trim() };
    }
    if (rawStun) console.warn("[turn-config] STUN_URL invalid — ignoring, using default STUN");
    console.log("[turn-config] STUN loaded (default)");
    return { urls: "stun:stun.l.google.com:19302" };
}

// Dynamic, time-limited TURN credential (coturn "use-auth-secret" REST API
// scheme). ttlSeconds bounds how long the credential is valid for — short
// enough that a leaked credential (e.g. from a device's captured network
// traffic) stops working soon, long enough that it comfortably outlives
// any single call/room session including reconnects.
function buildDynamicTurnEntries(ttlSeconds) {
    const secret = process.env.TURN_SECRET;
    const realm = process.env.TURN_REALM || "pingpong";
    const urls = parseTurnUrls(process.env.TURN_URL);
    if (!secret || !urls.length) return null;

    return function makeFor(userId) {
        const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
        // Username format required by the coturn REST API mechanism:
        // "<unix-expiry-timestamp>:<user-identifier>". realm is not part
        // of the username itself but is what the TURN server must be
        // configured with (static-auth-secret + realm matching TURN_REALM).
        const username = `${expiry}:${userId || "anon"}`;
        const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
        return urls.map((urls_) => ({ urls: urls_, username, credential }));
    };
}

function buildStaticTurnEntry() {
    const rawTurnUrl = process.env.TURN_URL;
    if (!rawTurnUrl) {
        console.log("[turn-config] TURN missing — STUN-only fallback active");
        return null;
    }
    const urls = parseTurnUrls(rawTurnUrl);
    const hasUsername = !!(process.env.TURN_USERNAME && process.env.TURN_USERNAME.trim());
    const hasCredential = !!(process.env.TURN_CREDENTIAL && process.env.TURN_CREDENTIAL.trim());
    if (!urls.length || !hasUsername || !hasCredential) {
        console.warn(`[turn-config] TURN_URL present but invalid/incomplete (validUrls:${urls.length} username:${hasUsername} credential:${hasCredential}) — TURN skipped, STUN-only fallback active`);
        return null;
    }
    console.log(`[turn-config] TURN loaded (static credential, ${urls.length} url(s))`);
    return urls.map((u) => ({ urls: u, username: process.env.TURN_USERNAME.trim(), credential: process.env.TURN_CREDENTIAL.trim() }));
}

// TTL configurable via env, defaults to 6 hours — comfortably longer than
// any realistic single voice session, short enough to bound credential
// leakage risk. Same default coturn deployments commonly use.
const TURN_CREDENTIAL_TTL_SECONDS = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS) || 6 * 60 * 60;

const stunEntry = buildStunEntry();
const dynamicTurnFactory = buildDynamicTurnEntries(TURN_CREDENTIAL_TTL_SECONDS);
const staticTurnEntries = dynamicTurnFactory ? null : buildStaticTurnEntry();

if (dynamicTurnFactory) {
    console.log(`[turn-config] TURN loaded (dynamic HMAC credential, ttl=${TURN_CREDENTIAL_TTL_SECONDS}s)`);
}

/**
 * @param {string} [userId] - used only to namespace the dynamic credential
 *   username for easier TURN-server-side auditing (which app user opened
 *   which relay allocation). Never required, never validated against
 *   anything — safe to omit.
 * @returns {Array<{urls:string,username?:string,credential?:string}>}
 */
function getIceServers(userId) {
    const servers = [stunEntry];
    if (dynamicTurnFactory) {
        servers.push(...dynamicTurnFactory(userId));
    } else if (staticTurnEntries) {
        servers.push(...staticTurnEntries);
    }
    return servers;
}

module.exports = { getIceServers, getIceServersAsync, isValidStunOrTurnUrl, getStatus };

// ==================================================
// PHASE 7 (2026-08-17) — CLOUDFLARE TURN, short-lived credentials
// ==================================================
// Additive: getIceServers() above is completely untouched, so every
// existing caller that doesn't opt into getIceServersAsync() keeps
// working exactly as before (STUN-only / legacy static / legacy dynamic
// HMAC TURN, whichever was already configured). getIceServersAsync() is
// the new preferred entry point — see cloudflareTurnClient.js for why the
// actual Cloudflare request/response handling lives in its own file.
//
// CACHING: Cloudflare TURN credentials are pooled/time-limited, not
// per-user — unlike the legacy HMAC path (which mints a fresh credential
// per userId), there is no reason to call Cloudflare's API more than once
// per TTL window. This module-level cache holds the most recent
// credential set and reuses it for every caller until shortly before it
// actually expires, refreshing lazily on the next call after that point
// (not on a background timer — a per-request lazy refresh is simpler,
// has no timer to leak/clear on shutdown, and the cost of an occasional
// extra ~200ms API round-trip on the rare request that lands exactly at
// expiry is negligible next to a voice call's own connection setup time).
//
// FAIL-SAFE: any Cloudflare API failure (network error, bad credentials,
// unexpected response shape) degrades to the legacy/STUN-only path below
// rather than ever failing the caller's request — a WebRTC connection
// with STUN-only ICE servers still works for many networks; a hard
// failure here would break voice entirely for everyone, which is a much
// worse outcome than a temporarily-missing TURN relay.

const cloudflareTurnClient = require("./cloudflareTurnClient.js");

const CLOUDFLARE_TURN_TTL_SECONDS = Number(process.env.CLOUDFLARE_TURN_TTL_SECONDS) || 3600; // Cloudflare recommends short-lived credentials; 1h default
const CLOUDFLARE_REFRESH_MARGIN_SECONDS = 60; // refresh this long before actual expiry, never serve a credential that's about to die mid-call-setup

let cfCache = null; // { iceServers, expiresAtMs } | null

function cloudflareConfigured() {
    return Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN);
}

function cfCacheIsFresh() {
    return Boolean(cfCache && Date.now() < cfCache.expiresAtMs);
}

async function fetchAndCacheCloudflareIceServers() {
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    const token = process.env.CLOUDFLARE_TURN_API_TOKEN; // read here only, passed by value, never logged — see cloudflareTurnClient.js header
    const result = await cloudflareTurnClient.generateIceServers(keyId, token, CLOUDFLARE_TURN_TTL_SECONDS);
    cfCache = {
        iceServers: result.iceServers,
        expiresAtMs: Date.now() + Math.max(0, (result.ttl - CLOUDFLARE_REFRESH_MARGIN_SECONDS)) * 1000
    };
    return cfCache.iceServers;
}

/**
 * Preferred entry point going forward. Returns { success, iceServers }
 * (matching the exact response shape callSignaling.js's /api/calls/
 * ice-servers route already returns, so no client-side change is
 * needed). Cloudflare TURN, when configured, takes priority over the
 * legacy STUN/static/dynamic-HMAC path above; falls back to it
 * automatically and silently (aside from a non-secret console.warn) on
 * any Cloudflare API failure.
 * @param {string} [userId] - forwarded to the legacy getIceServers()
 *   fallback path only; Cloudflare TURN credentials are not per-user.
 */
async function getIceServersAsync(userId) {
    if (!cloudflareConfigured()) {
        return { success: true, iceServers: getIceServers(userId) };
    }
    if (cfCacheIsFresh()) {
        return { success: true, iceServers: cfCache.iceServers };
    }
    try {
        const iceServers = await fetchAndCacheCloudflareIceServers();
        return { success: true, iceServers };
    } catch (e) {
        console.warn(`[turn-config] Cloudflare TURN request failed, falling back to STUN/legacy TURN: ${e && e.message}`);
        // A stale-but-not-yet-expired-by-much cached value is still better
        // than nothing if we have one; otherwise fall back to the
        // legacy/STUN path exactly as if Cloudflare were never configured.
        if (cfCache) return { success: true, iceServers: cfCache.iceServers };
        return { success: true, iceServers: getIceServers(userId) };
    }
}

// PHASE 6 (2026-08-17 — env/secrets hardening): presence-only status for
// admin/health reporting. Never returns actual secret/credential values —
// only booleans and non-secret metadata (url host counts, ttl), same
// discipline as voice_sfu/startupCheck.js's checkEnvVars(). The Cloudflare
// TURN credential *service* itself (actually calling Cloudflare's API) is
// Phase 7 — this only reports whether its env vars are present, so
// /api/admin/health can already show "turn: missing/legacy/cloudflare"
// before that service exists.
function getStatus() {
    const legacyStatic = Boolean(process.env.TURN_URL);
    const legacyDynamic = Boolean(process.env.TURN_SECRET && process.env.TURN_URL);
    const cloudflareVarsPresent = Boolean(
        process.env.CLOUDFLARE_ACCOUNT_ID &&
        process.env.CLOUDFLARE_TURN_KEY_ID &&
        process.env.CLOUDFLARE_TURN_API_TOKEN
    );
    let mode = "missing";
    if (cloudflareVarsPresent) mode = "cloudflare"; // Phase 7 will make this functional
    else if (legacyDynamic) mode = "legacy-dynamic";
    else if (legacyStatic) mode = "legacy-static";
    return {
        configured: mode !== "missing",
        mode, // "cloudflare" | "legacy-dynamic" | "legacy-static" | "missing"
        stunOnly: mode === "missing"
    };
}
