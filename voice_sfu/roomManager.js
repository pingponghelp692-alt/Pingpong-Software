// voice_sfu/roomManager.js
// ==================================================
// PHASE 3, STEP 3.2 — SFU ROOM MAPPING
// ==================================================
// Additive module, same init(deps) pattern as callSignaling.js/
// voice-health.js/room-recovery.js. Does NOT duplicate `rooms` (the
// existing in-memory room/seat store owned by server.js), redis/
// roomState.js, or redis/presence.js — it only ever READS the `rooms`
// object passed in at init time to answer "is this user actually
// allowed in this room right now", the exact same question
// relayVoiceSignal() already asks for the mesh path in server.js. This
// module adds no new room/seat authority; LiveKit room membership
// authorization piggybacks on the PingPong room's existing seat state.
//
// NAMING: PingPong roomId -> LiveKit room name is a pure, deterministic
// function (`pingpong-<roomId>`), not a stored mapping table — so it
// needs no persistence and is trivially reconstructible on any instance
// after a restart, consistent with turn-config.js's "stateless, any
// instance computes the same answer independently" design goal that
// Phase 2's multi-instance work already established as this codebase's
// convention.
//
// LOCAL BOOKKEEPING IS BEST-EFFORT ONLY: `participantCounts` here exists
// solely to feed voice_sfu/health.js's admin snapshot cheaply, without a
// live LiveKit API call on every dashboard refresh. LiveKit itself
// (via livekit.js's listParticipants) remains the actual source of
// truth for who is connected — exactly the same "client self-reports,
// server never treats it as authoritative for anything security-
// sensitive" trust model voice-health.js already documents for mesh
// connection-quality stats. In a multi-instance deployment each
// instance's count is only for the participants IT minted tokens for;
// this is called out explicitly in PHASE3_STEP32_REPORT.md as a known
// limitation, same category as voice-health.js's own per-instance note.

function initSfuRoomManager({ rooms }) {
    // key: liveKitRoomName -> count of tokens this instance has minted
    // and not yet recorded as left. Never used for authorization.
    const participantCounts = new Map();

    // PHASE 3, STEP 3.6 addition — key: liveKitRoomName -> Set<userId> of
    // identities this instance currently believes hold publish rights.
    // Same "best-effort bookkeeping only, never authorization" trust
    // model as participantCounts above (LiveKit's own per-participant
    // permission, set via livekit.js's updateParticipant, is what
    // actually enforces publish rights — this Set only feeds admin/
    // health metrics like "active publishers"). Kept as a Set rather
    // than a counter so repeated/out-of-order calls (a seat change event
    // firing more than once, or firing after a token join) are trivially
    // idempotent instead of needing careful increment/decrement pairing.
    const publisherSets = new Map();

    // PHASE 3, STEP 3.4 addition — read-only accessor to the SAME `rooms`
    // object closed over above, exposed so voice_sfu/sync.js can re-check
    // current PingPong room state (e.g. "is it still empty right now?")
    // right before an async LiveKit cleanup call actually fires, without
    // sync.js needing its own reference to `rooms` passed in separately.
    // Never mutates; callers must treat the return value as read-only.
    function getPingPongRoom(pingpongRoomId) {
        return rooms[pingpongRoomId] || null;
    }

    // PHASE 3, STEP 3.4 addition — explicit bookkeeping reset, used by
    // sync.js right after it successfully deletes a LiveKit room, so this
    // instance's local participantCounts entry can't linger and feed a
    // stale non-zero number into health.js's activeLocalRooms list for a
    // room that no longer exists on the LiveKit side.
    function clearLocalCount(liveKitRoomName) {
        participantCounts.delete(liveKitRoomName);
        publisherSets.delete(liveKitRoomName); // PHASE 3, STEP 3.6 — no orphaned publisher bookkeeping for a room whose LiveKit room was just deleted
    }

    // PHASE 3, STEP 3.6 addition — "is this user a current member of the
    // PingPong room at all (seated OR audience)?" Reuses the SAME `rooms`
    // object and `onlineUsers` array server.js already maintains for
    // every socket that has successfully joined the room (see server.js's
    // `join-room` handler) — no new membership/authorization model. This
    // is the audience-token authorization check: isUserSeatedInRoom above
    // remains the (stricter) publish-rights check; this is the (looser)
    // "may at least listen" check.
    function isUserInRoom(pingpongRoomId, userId) {
        const room = rooms[pingpongRoomId];
        if (!room || !Array.isArray(room.onlineUsers)) return false;
        return room.onlineUsers.some((u) => u && u.userId === userId);
    }

    // PHASE 3, STEP 3.6 addition — records/clears this instance's belief
    // about whether `userId` currently holds publish rights in the mapped
    // LiveKit room. Called from voice_sfu/index.js's /join and /leave
    // routes (initial token mint) AND from voice_sfu/sync.js's
    // onSeatChanged (every later seat transition) so the count stays
    // accurate even when a seat upgrade/downgrade happens WITHOUT the
    // client re-hitting /join (see PHASE3_STEP36_REPORT.md — the client
    // upgrades an existing LiveKit connection in place rather than
    // reconnecting, so /join is not called again on a seat change).
    function setPublisherStatus(liveKitRoomName, userId, isPublisher) {
        if (!liveKitRoomName || !userId) return;
        let set = publisherSets.get(liveKitRoomName);
        if (isPublisher) {
            if (!set) { set = new Set(); publisherSets.set(liveKitRoomName, set); }
            set.add(userId);
        } else if (set) {
            set.delete(userId);
            if (set.size === 0) publisherSets.delete(liveKitRoomName);
        }
    }

    function getLocalPublisherCount(liveKitRoomName) {
        const set = publisherSets.get(liveKitRoomName);
        return set ? set.size : 0;
    }

    function toLiveKitRoomName(pingpongRoomId) {
        // Sanitize: LiveKit room names are opaque strings but keeping this
        // predictable and collision-free with a fixed prefix avoids any
        // ambiguity if a raw roomId ever contained unexpected characters.
        const safe = String(pingpongRoomId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
        return `pingpong-${safe}`;
    }

    // Mirrors the same authorization question server.js's
    // relayVoiceSignal() already asks for the mesh path: is this user
    // currently seated in this room? Reuses the SAME `rooms` object and
    // seat shape — no new authorization model introduced.
    function isUserSeatedInRoom(pingpongRoomId, userId) {
        const room = rooms[pingpongRoomId];
        if (!room || !Array.isArray(room.seats)) return false;
        return room.seats.some((seat) => seat && seat.userId === userId);
    }

    function recordJoin(liveKitRoomName) {
        participantCounts.set(liveKitRoomName, (participantCounts.get(liveKitRoomName) || 0) + 1);
    }

    function recordLeave(liveKitRoomName) {
        const cur = participantCounts.get(liveKitRoomName) || 0;
        if (cur <= 1) participantCounts.delete(liveKitRoomName);
        else participantCounts.set(liveKitRoomName, cur - 1);
    }

    function getLocalParticipantCount(liveKitRoomName) {
        return participantCounts.get(liveKitRoomName) || 0;
    }

    function listActiveLocalRooms() {
        // PHASE 3, STEP 3.6: added localPublisherCount alongside the
        // existing localParticipantCount field — same field name/shape
        // for everything that existed before, purely additive.
        return Array.from(participantCounts.entries()).map(([roomName, count]) => ({
            roomName, localParticipantCount: count, localPublisherCount: getLocalPublisherCount(roomName)
        }));
    }

    return {
        toLiveKitRoomName,
        isUserSeatedInRoom,
        isUserInRoom,
        recordJoin,
        recordLeave,
        getLocalParticipantCount,
        listActiveLocalRooms,
        getPingPongRoom,
        clearLocalCount,
        setPublisherStatus,
        getLocalPublisherCount
    };
}

module.exports = { initSfuRoomManager };
