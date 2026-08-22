// voice_sfu/livekit.js
// ==================================================
// PHASE 3, STEP 3.2 — LIVEKIT SERVER-ADMIN CLIENT
// ==================================================
// Wraps LiveKit's RoomServiceClient (server-to-server REST, signed with
// LIVEKIT_API_KEY/LIVEKIT_API_SECRET — never sent to a browser, unlike
// token.js's per-user JWTs). This is the ONLY file in voice_sfu/ that
// imports RoomServiceClient, so the secret-bearing client has exactly
// one entry point to audit.
//
// Same init(deps)-free, lazy-require pattern as token.js: nothing here
// runs, connects, or even requires livekit-server-sdk until a function
// is actually called, so VOICE_MODE=mesh deployments are completely
// unaffected — this file can exist, be required by voice_sfu/index.js,
// and do nothing at all.
//
// WHAT THIS DOES NOT DO (by design, per the Step 3.2 spec):
//   - Does not touch turn-config.js. LiveKit uses its own internal
//     ICE/TURN handling on the media-server side; the existing
//     STUN/TURN env vars keep serving the mesh + private-call/
//     call-hosting P2P paths exactly as before, untouched.
//   - Does not duplicate redis/roomState.js, redis/presence.js, or any
//     PingPong room/seat state. LiveKit is the source of truth for who
//     is actually connected to SFU media; this file only ever asks
//     LiveKit's own API "what's true right now" rather than keeping a
//     second, potentially-stale copy of that answer.

const { isConfigured } = require("./token.js");

function loadSdk() {
    try {
        return require("livekit-server-sdk");
    } catch (e) {
        const err = new Error("livekit-server-sdk is not installed. Run: npm install livekit-server-sdk");
        err.code = "LIVEKIT_SDK_MISSING";
        throw err;
    }
}

let cachedClient = null;
function getClient() {
    if (!isConfigured()) {
        const err = new Error("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing)");
        err.code = "LIVEKIT_NOT_CONFIGURED";
        throw err;
    }
    if (cachedClient) return cachedClient;
    const { RoomServiceClient } = loadSdk();
    // LiveKit's Node SDK expects the *HTTP(S)* URL for server-admin calls
    // even though clients connect with wss:// — accept either LIVEKIT_URL
    // form so an operator pasting their LiveKit Cloud "wss://..." project
    // URL (the value LiveKit's own dashboard shows first) doesn't produce
    // a confusing connection error.
    const rawUrl = process.env.LIVEKIT_URL || "";
    const httpUrl = rawUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    cachedClient = new RoomServiceClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    return cachedClient;
}

// Idempotent: LiveKit's createRoom on an already-existing room name is a
// safe no-op-ish call (returns the existing room), so callers don't need
// a separate "does it exist" check first — mirrors this codebase's
// general preference for idempotent operations (see coinCenter.js's
// idempotent transfers, mentioned in its own header).
async function ensureRoom(roomName, { maxParticipants, metadata } = {}) {
    const client = getClient();
    return client.createRoom({
        name: roomName,
        maxParticipants: Number.isFinite(maxParticipants) ? maxParticipants : 8, // matches the existing mesh seat cap by default; see roomManager.js
        metadata: metadata ? JSON.stringify(metadata).slice(0, 2000) : undefined,
        emptyTimeout: 5 * 60 // seconds; LiveKit auto-closes an empty room 5 min after the last participant leaves, so a crash/restart here can never orphan a room forever even if cleanupRoom() below never runs
    });
}

async function listParticipants(roomName) {
    const client = getClient();
    return client.listParticipants(roomName);
}

async function removeParticipant(roomName, identity) {
    const client = getClient();
    return client.removeParticipant(roomName, identity);
}

async function updateRoomMetadata(roomName, metadata) {
    const client = getClient();
    return client.updateRoomMetadata(roomName, JSON.stringify(metadata || {}).slice(0, 2000));
}

// PHASE 3, STEP 3.4 addition — per-participant metadata/permission update.
// Used by voice_sfu/sync.js to mirror PingPong seat/role state onto the
// matching LiveKit participant (metadata) and, where it matters for
// correctness (seat sync, spec requirement #3), to actually revoke/grant
// publish rights server-side via LiveKit's own permission model — NOT a
// second authorization system: the values passed in always come from the
// SAME `rooms` seat state server.js already owns, this only mirrors it.
// Safe to call for a participant who isn't currently connected to LiveKit
// (never got/used an SFU token, or already disconnected) — that's a normal
// "not found"-shaped rejection from LiveKit's API, which callers in
// sync.js already treat as non-fatal (see its `safe()` wrapper).
async function updateParticipant(roomName, identity, { metadata, permission } = {}) {
    const client = getClient();
    const metadataStr = metadata ? JSON.stringify(metadata).slice(0, 2000) : undefined;
    return client.updateParticipant(roomName, identity, metadataStr, permission);
}

// Explicit cleanup for the emergency-stop / room-deleted path (server.js
// already deletes a PingPong room object in several places — Step 3.2
// does NOT hook into those automatically per "no unnecessary
// refactoring"; see PHASE3_STEP32_REPORT.md's "remaining work" section.
// This function exists so that hook can be a one-line, additive call
// later without needing new plumbing at that point.
async function deleteRoom(roomName) {
    const client = getClient();
    return client.deleteRoom(roomName);
}

async function listRooms() {
    const client = getClient();
    return client.listRooms();
}

module.exports = { ensureRoom, listParticipants, removeParticipant, updateRoomMetadata, updateParticipant, deleteRoom, listRooms };
