// redis/userState.js
// ==================================================
// PHASE 2A — SHARED USER STATE (mirror)
// ==================================================
// Mirrors each online user's runtime state into Redis so it's visible
// to other processes/instances later (Tier B horizontal scaling), WITHOUT
// touching how server.js currently reads this data. Every existing
// socket handler keeps reading `socketsByUserId` / `socket.currentRoom`
// exactly as before — this module only writes a copy out to Redis on an
// interval, following the same polling pattern already established by
// health-check.js's takeSnapshot().
//
// STORED PER USER (Redis hash at key `user:state:{userId}`):
//   online          "1" (key existing = online; TTL-expired/absent = offline)
//   currentRoom     roomId or ""
//   currentSeat     seat index (0-7) or "" if not seated
//   inCall          "1"/"0" — derived proxy for "voice status" (see note
//                   below on why this isn't a finer-grained quality value)
//   socketId        this instance's live socket.id for the user
//   instanceId      identifies which process/instance wrote this sample
//                   (needed once you run more than one instance — a
//                   user's "latest" state should come from whichever
//                   instance most recently wrote it)
//   updatedAt       ISO timestamp of this snapshot
//
// TTL: each hash is written with a ~90s expiry that gets refreshed every
// sync cycle. If a process crashes without a clean shutdown, its users'
// entries simply expire out of Redis instead of going stale forever —
// no explicit disconnect hook required, which is what lets this module
// avoid touching any existing disconnect-handling code.
//
// VOICE STATUS NOTE: voice-health.js (Phase 1) only exposes room-level
// aggregates (getRoomHealth/getGlobalSummary), not a per-user quality
// score, so "voice status" here is the boolean "currently seated in a
// room with an active call context" rather than a MOS-style number. If
// voice-health.js later exports a per-user getter, wire it in here —
// this module already isolates that one field (`inCall`) so doing so
// won't touch anything else.

const client = require("./client.js");

const STATE_TTL_SECONDS = 90;
const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;

function userKey(userId) {
    return client.prefixed(`user:state:${userId}`);
}

// Builds a snapshot for one user from the in-memory sources server.js
// already maintains. Read-only — never mutates rooms/socketsByUserId/io.
function buildSnapshot(userId, { io, rooms, socketsByUserId }) {
    const socketId = socketsByUserId[userId];
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    if (!socket) return null; // not actually online — caller should remove, not write

    const roomId = socket.currentRoom || "";
    let seatIndex = "";
    let inCall = false;
    if (roomId && rooms[roomId]) {
        const seats = rooms[roomId].seats || [];
        const idx = seats.findIndex((s) => s && s.userId === userId);
        if (idx !== -1) {
            seatIndex = String(idx);
            inCall = true;
        }
    }

    return {
        online: "1",
        currentRoom: roomId,
        currentSeat: String(seatIndex),
        inCall: inCall ? "1" : "0",
        socketId,
        instanceId: INSTANCE_ID,
        updatedAt: new Date().toISOString(),
    };
}

async function syncUser(userId, deps) {
    if (!client.isEnabled()) return;
    const conn = client.getConnection();
    if (!conn) return;
    const snapshot = buildSnapshot(userId, deps);
    try {
        if (!snapshot) {
            await conn.del(userKey(userId));
            return;
        }
        const multi = conn.multi();
        multi.hset(userKey(userId), snapshot);
        multi.expire(userKey(userId), STATE_TTL_SECONDS);
        await multi.exec();
    } catch (e) {
        console.warn(`[redis/userState] syncUser(${userId}) failed: ${e.message}`);
    }
}

// Full pass over every currently-online user on this instance. Called
// on an interval by redis/index.js — this is the only thing that
// actually keeps Redis in sync; nothing hooks into login/logout/seat
// events directly, by design (see file header).
async function syncAll(deps) {
    if (!client.isEnabled()) return;
    const { socketsByUserId } = deps;
    const userIds = Object.keys(socketsByUserId);
    for (const userId of userIds) {
        await syncUser(userId, deps);
    }
}

// Read-only query, for future use by other instances / admin tooling.
// Returns null if the user isn't known to Redis (offline or Redis
// disabled) rather than throwing.
async function getUserState(userId) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    try {
        const data = await conn.hgetall(userKey(userId));
        return Object.keys(data).length ? data : null;
    } catch (e) {
        console.warn(`[redis/userState] getUserState(${userId}) failed: ${e.message}`);
        return null;
    }
}

module.exports = { syncUser, syncAll, getUserState, STATE_TTL_SECONDS };
