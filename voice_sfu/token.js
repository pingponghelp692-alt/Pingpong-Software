// voice_sfu/token.js
// ==================================================
// PHASE 3, STEP 3.2 — SFU ACCESS TOKEN GENERATION
// ==================================================
// Purely additive module, same init(deps)-free "lazy require + pure
// functions" style as turn-config.js — no global state, no side effects
// at require-time beyond reading env vars when a function is actually
// called.
//
// WHY A SEPARATE FILE FROM livekit.js: token minting (client-facing) and
// room/participant server administration (server-to-server REST) are two
// different LiveKit SDK surfaces (AccessToken vs RoomServiceClient) with
// different trust boundaries — a token is safe to hand to a browser, a
// RoomServiceClient with the API secret is not. Keeping them in separate
// files makes it structurally obvious which code path can leak a secret
// to a client and which can't (livekit.js's client is never imported by
// anything that formats an HTTP response body directly).
//
// LAZY REQUIRE: `livekit-server-sdk` is only required() inside the
// function body, not at module load time. This means:
//   - VOICE_MODE=mesh (the default) never even attempts to load the
//     package, so a deployment that hasn't run `npm install
//     livekit-server-sdk` yet keeps working with zero errors, exactly as
//     required ("Mesh remains default. Changing to SFU must only require
//     configuration.").
//   - Only calling mintAccessToken()/isConfigured() while VOICE_MODE=sfu
//     surfaces a missing-dependency error, and only for that call — it
//     can never crash server startup or the mesh path.

function isConfigured() {
    return Boolean(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL);
}

// Mirrors turn-config.js's TURN_CREDENTIAL_TTL_SECONDS pattern: a single,
// documented, overridable env var with a sane default rather than a
// hardcoded magic number.
function tokenTtlSeconds() {
    const raw = parseInt(process.env.LIVEKIT_TOKEN_TTL_SECONDS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60; // default 6h, same default as turn-config.js's dynamic TURN credentials
}

// identity: PingPong userId (stable, used by LiveKit to dedupe/replace a
// stale connection from the same user — mirrors how socketsByUserId
// already treats one live connection per userId elsewhere in this app).
// roomName: the mapped LiveKit room name (see roomManager.js — NEVER the
// raw PingPong roomId is trusted as-is without going through that
// mapping, so a future roomId format change can't silently change
// LiveKit room identity).
// canPublish: false for audience/non-seated viewers if that's ever
// wired up later (Step 3.3+); Step 3.2 only issues tokens for seated
// speakers, same trust boundary the mesh path already enforces via
// relayVoiceSignal()'s same-room-and-seated check in server.js.
async function mintAccessToken({ identity, roomName, name, metadata, canPublish = true, canSubscribe = true }) {
    if (!isConfigured()) {
        const err = new Error("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing)");
        err.code = "LIVEKIT_NOT_CONFIGURED";
        throw err;
    }
    if (!identity || typeof identity !== "string") throw new Error("mintAccessToken: identity is required");
    if (!roomName || typeof roomName !== "string") throw new Error("mintAccessToken: roomName is required");

    let AccessToken;
    try {
        ({ AccessToken } = require("livekit-server-sdk"));
    } catch (e) {
        const err = new Error("livekit-server-sdk is not installed. Run: npm install livekit-server-sdk");
        err.code = "LIVEKIT_SDK_MISSING";
        throw err;
    }

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity,
        name: typeof name === "string" ? name.slice(0, 128) : undefined,
        ttl: tokenTtlSeconds(),
        metadata: metadata ? JSON.stringify(metadata).slice(0, 2000) : undefined // LiveKit metadata is a string; cap it defensively, same spirit as sanitizeText() caps elsewhere in this codebase
    });
    at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: Boolean(canPublish),
        canSubscribe: Boolean(canSubscribe),
        canPublishData: true // used for future in-room signaling over LiveKit's data channel if ever needed; does not grant media publish beyond canPublish
    });

    // Newer livekit-server-sdk versions return a Promise from toJwt();
    // older ones return the string synchronously. Awaiting a non-promise
    // value is a no-op, so this line is safe across SDK versions without
    // a version check.
    return await at.toJwt();
}

module.exports = { isConfigured, tokenTtlSeconds, mintAccessToken };
