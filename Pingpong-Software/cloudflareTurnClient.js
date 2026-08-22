// cloudflareTurnClient.js
// ==================================================
// PHASE 7 (2026-08-17) — CLOUDFLARE TURN CREDENTIAL SERVICE
// ==================================================
// The ONLY file in this project that knows Cloudflare's specific TURN
// credential-generation request/response shape — same isolation pattern
// as ai/providers/gemini-provider.js (the only file that knows Gemini's
// shape) and ai/providers/openai-provider.js. turn-config.js talks to
// this through generateIceServers(keyId, token, ttlSeconds) only, so
// swapping/mocking the actual network call (in tests) or the provider
// itself (if Cloudflare's API ever changes) means touching only this
// file — nothing else in the app has to change.
//
// SECURITY: CLOUDFLARE_TURN_API_TOKEN is read by the CALLER (turn-
// config.js, from process.env) and passed in as a parameter — this file
// never reads process.env itself, so it can't accidentally pick up or
// leak a secret through some other path. The token is sent exactly once,
// server-side, as an Authorization: Bearer header to Cloudflare's API —
// never returned to the caller, never logged, never included in any
// thrown Error's message (see the redaction in the error path below).
//
// ENDPOINT: Cloudflare's Calls TURN service issues short-lived ICE server
// credentials keyed by a TURN Key ID (created in the Cloudflare dashboard
// under Calls -> TURN), authenticated with a scoped API token — NOT the
// account-wide Cloudflare API token used for other Cloudflare products.
// Per the spec this module was built against:
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
//   Authorization: Bearer <CLOUDFLARE_TURN_API_TOKEN>
//   Body: { "ttl": <seconds> }
//
// HONEST LIMITATION (documented, not hidden): this sandbox has no network
// egress, so the exact response shape below is implemented from
// Cloudflare's documented API contract, not verified against a live call.
// generateIceServers() normalizes a couple of plausible response shapes
// (see normalizeIceServers() below) specifically so a small, real-world
// shape variation doesn't hard-fail the whole TURN service — but the
// actual live shape MUST be verified once this runs with real network
// access (Termux), which is exactly the boundary already agreed for this
// phase: mock-tested here, live-verified on-device.

const CLOUDFLARE_TURN_ENDPOINT_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

// Cloudflare's documented response for this endpoint is a single
// iceServers OBJECT: { urls: [...], username, credential }. Some TURN/ICE
// consumers (and a couple of other providers' similar endpoints) instead
// return an ARRAY of such objects. Both are valid RTCIceServer-shaped
// input to a WebRTC PeerConnection, so this accepts either and always
// returns an ARRAY (the shape RTCPeerConnection's iceServers config and
// this project's existing turn-config.js/callSignaling.js callers expect)
// — never guesses at fields that aren't present.
function normalizeIceServers(raw) {
    if (!raw) return null;
    const body = raw.iceServers !== undefined ? raw.iceServers : raw;
    if (Array.isArray(body)) {
        const cleaned = body.filter((s) => s && (s.urls || s.url));
        return cleaned.length ? cleaned : null;
    }
    if (body && typeof body === "object" && (body.urls || body.url)) {
        return [body];
    }
    return null;
}

// Redacts a bearer token from anything that might end up in a thrown
// Error's message (e.g. an API error response that happens to echo the
// Authorization header back, which some APIs do for debugging) — belt-
// and-suspenders on top of never logging `token` directly below.
function redact(str, token) {
    if (!token || typeof str !== "string") return str;
    return str.split(token).join("[REDACTED]");
}

// keyId/token are passed in explicitly (never read from process.env
// here — see file header). Throws on any failure; never returns a
// partial/guessed result. Caller (turn-config.js) decides how to
// degrade (fall back to legacy TURN/STUN) when this throws.
async function generateIceServers(keyId, token, ttlSeconds) {
    if (!keyId || !token) {
        throw new Error("generateIceServers requires both a TURN key ID and API token");
    }
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 3600;
    const url = `${CLOUDFLARE_TURN_ENDPOINT_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;

    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ ttl })
        });
    } catch (networkErr) {
        // Network-level failure (DNS, connection refused, timeout) — never
        // include `token` in what we throw, even indirectly via
        // networkErr's own message (some HTTP client errors echo request
        // details back).
        throw new Error(`Cloudflare TURN request failed: ${redact(networkErr && networkErr.message, token)}`);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Cloudflare TURN API error ${res.status}: ${redact(errText.slice(0, 300), token)}`);
    }

    let data;
    try {
        data = await res.json();
    } catch (parseErr) {
        throw new Error("Cloudflare TURN API returned a non-JSON response");
    }

    const iceServers = normalizeIceServers(data);
    if (!iceServers) {
        throw new Error("Cloudflare TURN API response did not contain a recognizable iceServers shape");
    }
    return { iceServers, ttl };
}

module.exports = { generateIceServers, normalizeIceServers };
