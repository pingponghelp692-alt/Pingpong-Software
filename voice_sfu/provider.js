// voice_sfu/provider.js
// ==================================================
// PHASE 3, STEP 3.2 — VOICE PROVIDER ABSTRACTION
// ==================================================
// Implements the "VoiceProvider / MeshProvider / SFUProvider" split the
// Step 3.2 spec asks for. Both providers expose the exact same async
// interface — getConnectionInfo({ roomId, userId, userName }) — so any
// future caller (a socket handler, a REST route) can do:
//
//     const info = await provider.getConnectionInfo({ roomId, userId });
//
// without an if/else on VOICE_MODE anywhere in business logic. Today
// (Step 3.2) the only caller is voice_sfu/index.js's own REST routes;
// no existing file has been changed to call this, which is intentional
// — see PHASE3_STEP32_REPORT.md for why wiring a provider-aware call
// site into public/app.js is Step 3.3 work, not this step's.
//
// MeshProvider is a thin, additive wrapper — it does NOT reimplement ICE
// server logic. It reuses turn-config.js's getIceServers() as-is (the
// exact function callSignaling.js already calls for /api/calls/ice-
// servers), so "mesh mode" through this abstraction and the existing
// mesh path give byte-identical ICE server answers.
//
// SFUProvider mints a LiveKit token via token.js and ensures the mapped
// LiveKit room exists via livekit.js, gated on the same seat-membership
// check roomManager.js exposes.

const { getIceServersAsync } = require("../turn-config.js");
const { mintAccessToken, isConfigured: sfuConfigured } = require("./token.js");
const rollout = require("./rollout.js");

function currentVoiceMode() {
    const mode = (process.env.VOICE_MODE || "mesh").trim().toLowerCase();
    return mode === "sfu" ? "sfu" : "mesh"; // any unrecognized value safely falls back to mesh — never fails open into an unconfigured SFU path
}

// PHASE 3, STEP 3.5 addition — unchanged behavior for existing callers of
// currentVoiceMode()/getActiveProvider() (both above are byte-identical
// to Step 3.2-3.4). This is the NEW per-room-aware answer, needed once
// VOICE_MODE can also be "staged" (see rollout.js). For "mesh"/"sfu" it
// returns exactly what currentVoiceMode() would; for "staged" it asks
// rollout.js to decide THIS room's mode from its own state (hostId) plus
// the staged-rollout env knobs. Always resolves to "mesh" or "sfu",
// never "staged" itself — "staged" is a config-time concept only, never
// a value business logic branches on downstream.
function effectiveVoiceModeForRoom({ roomId, roomManager }) {
    const base = rollout.rawBaseMode();
    if (base !== "staged") return currentVoiceMode();
    const room = roomManager && typeof roomManager.getPingPongRoom === "function" ? roomManager.getPingPongRoom(roomId) : null;
    return rollout.resolveRoomVoiceMode(roomId, room);
}

function createMeshProvider() {
    return {
        mode: "mesh",
        // PHASE 7 (2026-08-17): prefers Cloudflare TURN via
        // getIceServersAsync() when configured, falling back to the exact
        // getIceServers() behavior otherwise. Only the iceServers array is
        // taken from the async result — getConnectionInfo()'s own return
        // shape ({mode, iceServers}) is unchanged, so every existing
        // caller of this provider abstraction keeps working as-is.
        async getConnectionInfo({ userId } = {}) {
            const result = await getIceServersAsync(userId);
            return { mode: "mesh", iceServers: result.iceServers };
        }
    };
}

function createSfuProvider({ roomManager, livekit }) {
    return {
        mode: "sfu",
        // PHASE 3, STEP 3.6: previously required isUserSeatedInRoom and
        // rejected everyone else with NOT_SEATED. Now issues a token to
        // ANY current room member (roomManager.isUserInRoom — seated OR
        // audience), with canPublish set from the SEAT check specifically.
        // This is the audience-listening feature: an audience token has
        // canPublish:false baked in at mint time (LiveKit's own grant,
        // enforced server-side by LiveKit itself — this app never re-
        // implements that enforcement) and canSubscribe:true, so the
        // holder can hear every seated speaker but cannot publish, and
        // cannot bypass this by holding onto an old token from before a
        // seat change either (see sync.js's onSeatChanged, which updates
        // the LIVE LiveKit-side permission on every later seat/audience
        // transition — the token's baked-in grant is only ever the
        // STARTING permission for a fresh connection, not the ongoing
        // authority once connected). No second permission system: seated
        // vs. not-seated is answered by the exact same
        // roomManager.isUserSeatedInRoom() this file already used.
        async getConnectionInfo({ roomId, userId, userName }) {
            if (!sfuConfigured()) {
                const err = new Error("VOICE_MODE=sfu but LiveKit env vars are not set");
                err.code = "LIVEKIT_NOT_CONFIGURED";
                throw err;
            }
            const seated = roomManager.isUserSeatedInRoom(roomId, userId);
            const inRoom = seated || (typeof roomManager.isUserInRoom === "function" && roomManager.isUserInRoom(roomId, userId));
            if (!inRoom) {
                const err = new Error("User is not currently in this room");
                err.code = "NOT_IN_ROOM";
                throw err;
            }
            const liveKitRoomName = roomManager.toLiveKitRoomName(roomId);
            await livekit.ensureRoom(liveKitRoomName, { metadata: { pingpongRoomId: roomId } });
            const token = await mintAccessToken({
                identity: userId,
                roomName: liveKitRoomName,
                name: userName,
                metadata: { pingpongRoomId: roomId },
                canPublish: seated,
                canSubscribe: true
            });
            return { mode: "sfu", livekitUrl: process.env.LIVEKIT_URL, roomName: liveKitRoomName, token, canPublish: seated };
        }
    };
}

// Single entry point business logic should use: always returns a
// provider matching the CURRENT VOICE_MODE at call time (read fresh each
// call, not cached at startup) so an operator flipping VOICE_MODE and
// restarting takes effect with zero code changes, per spec requirement
// #3 ("Changing to SFU must only require configuration").
function getActiveProvider({ roomManager, livekit }) {
    return currentVoiceMode() === "sfu" ? createSfuProvider({ roomManager, livekit }) : createMeshProvider();
}

// PHASE 3, STEP 3.5 addition — the room-aware counterpart to
// getActiveProvider() above, used by the /join route (the only place
// that actually needs to pick a provider on behalf of one specific
// room). getActiveProvider() itself is left completely unchanged so
// nothing that already calls it (there are no other callers today, but
// the function is kept as-is per "no unnecessary refactoring") needs to
// change behavior.
function getActiveProviderForRoom({ roomId, roomManager, livekit }) {
    const mode = effectiveVoiceModeForRoom({ roomId, roomManager });
    return mode === "sfu" ? createSfuProvider({ roomManager, livekit }) : createMeshProvider();
}

module.exports = {
    currentVoiceMode, createMeshProvider, createSfuProvider, getActiveProvider,
    effectiveVoiceModeForRoom, getActiveProviderForRoom
};
