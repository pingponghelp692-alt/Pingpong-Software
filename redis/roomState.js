// redis/roomState.js
// ==================================================
// PHASE 2A — SHARED ROOM STATE (mirror)
// ==================================================
// Mirrors each active room's runtime state into Redis, same
// polling-snapshot approach as userState.js — server.js's `rooms`
// object and every place that reads/writes it stay completely
// untouched. See userState.js's header for the full rationale.
//
// STORED PER ROOM (Redis string at key `room:state:{roomId}`, JSON):
//   roomId, roomNumber, roomName, hostId, hostName, adminIds
//   seats            array of {userId, ...} | null, 8 slots (seat status)
//   onlineUserIds     array of userIds currently in the room (members)
//   mutedUntil        map of userId -> timestamp (mute status)
//   seatLabels        map of userId -> room-local label
//   lockedSeats       array of locked seat indices
//   roomLocked, gameEnabled, countryId, agencyId, background, logo
//                     (room metadata)
//   videoPlayer       {mode, currentIndex, isPlaying, position, updatedAt}
//                     (a runtime variable, kept small/derived — NOT the
//                     full videoPlaylist, see exclusions below)
//   memberCount       convenience count, derived
//   instanceId, updatedAt
//
// DELIBERATELY EXCLUDED from the mirror (kept in-memory / on-disk only,
// unchanged from today):
//   - roomPasswordHash  — never leaves server.js's process memory via
//                          this module; publicRoom() already strips it
//                          for clients and we follow the same rule here
//   - messages           — chat history is high-volume and already has
//                          its own persistence path; mirroring it here
//                          would bloat every sync cycle for no Tier-2A
//                          benefit
//   - videoPlaylist       — same reasoning: large, already
//                          persisted/loaded separately (VIDEO_PLAYLISTS_FILE)
//   - emptyCleanupTimer   — a Node Timeout object; not serializable and
//                          meaningless outside this process anyway
// These can be added later if a real Tier B use case needs them —
// nothing here forecloses that.
//
// TTL: ~90s, refreshed every cycle, same self-expiry rationale as
// userState.js.

const client = require("./client.js");

const STATE_TTL_SECONDS = 90;
const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;

function roomKey(roomId) {
    return client.prefixed(`room:state:${roomId}`);
}

function buildSnapshot(room) {
    const onlineUserIds = (room.onlineUsers || []).map((u) => u.userId).filter(Boolean);
    return {
        roomId: room.roomId,
        roomNumber: room.roomNumber || null,
        roomName: room.roomName || null,
        hostId: room.hostId || null,
        hostName: room.hostName || null,
        adminIds: room.adminIds || [],
        agencyId: room.agencyId || null,
        countryId: room.countryId || "OTHERS",
        background: room.background || null,
        logo: room.logo || null,
        roomLocked: !!room.roomLocked,
        gameEnabled: room.gameEnabled !== false,
        seats: (room.seats || []).map((s) => (s ? { userId: s.userId, seatIndex: s.seatIndex } : null)),
        onlineUserIds,
        memberCount: onlineUserIds.length,
        mutedUntil: room.mutedUntil || {},
        seatLabels: room.seatLabels || {},
        lockedSeats: room.lockedSeats || [],
        chatBannedIds: room.chatBannedIds || [],
        videoPlayer: room.videoPlayer || null,
        instanceId: INSTANCE_ID,
        updatedAt: new Date().toISOString(),
    };
}

async function syncRoom(roomId, { rooms }) {
    if (!client.isEnabled()) return;
    const conn = client.getConnection();
    if (!conn) return;
    const room = rooms[roomId];
    try {
        if (!room) {
            await conn.del(roomKey(roomId));
            return;
        }
        const snapshot = buildSnapshot(room);
        await conn.set(roomKey(roomId), JSON.stringify(snapshot), "EX", STATE_TTL_SECONDS);
    } catch (e) {
        console.warn(`[redis/roomState] syncRoom(${roomId}) failed: ${e.message}`);
    }
}

async function syncAll(deps) {
    if (!client.isEnabled()) return;
    const { rooms } = deps;
    for (const roomId of Object.keys(rooms)) {
        await syncRoom(roomId, deps);
    }
}

async function getRoomState(roomId) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    try {
        const raw = await conn.get(roomKey(roomId));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.warn(`[redis/roomState] getRoomState(${roomId}) failed: ${e.message}`);
        return null;
    }
}

// GAP #1 (Redis Authoritative Runtime State) — cluster-wide room
// discovery. SCAN-based, never blocks Redis, same pattern as
// redis/clusterRead.js's scanCount. Returns roomIds only (not full
// state) so callers can cheaply diff against their own local `rooms`
// object and only fetch full state (getRoomState, above) for the ones
// they don't already have locally.
async function listRoomIds() {
    if (!client.isEnabled()) return [];
    const conn = client.getConnection();
    if (!conn) return [];
    const prefixLen = client.prefixed("room:state:").length;
    let cursor = "0";
    const ids = [];
    try {
        do {
            const [next, keys] = await conn.scan(cursor, "MATCH", client.prefixed("room:state:*"), "COUNT", 200);
            cursor = next;
            for (const key of keys) ids.push(key.slice(prefixLen));
        } while (cursor !== "0");
        return ids;
    } catch (e) {
        console.warn(`[redis/roomState] listRoomIds failed: ${e.message}`);
        return [];
    }
}

module.exports = { syncRoom, syncAll, getRoomState, listRoomIds, STATE_TTL_SECONDS };
