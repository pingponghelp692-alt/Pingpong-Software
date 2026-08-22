// module4/redis/roomState.js
// ==================================================
// MODULE 4 — STEP 4.3: DISTRIBUTED ROOM STATE (infrastructure layer)
// ==================================================
// Second entity from the Step 4.1 migration order: room/seats/host/
// moderators/mute state, Redis-authoritative once merged.
//
// THIS FILE IS INFRASTRUCTURE ONLY — it does not know or enforce any
// business rule from server.js (who's allowed to sit where, seat
// count, VIP badge display, chest/game state, etc.). It only offers
// generic, lock-protected read-modify-write primitives over a room's
// state document, shaped to match the fields server.js already uses
// (roomId, hostId, adminIds, seats, mutedUntil — see server.js's
// `loadRooms()` for the source shape this mirrors field-for-field so
// a later merge can map 1:1 instead of translating). All actual game/
// room logic stays exactly where it is in server.js; this module is
// only the shared-storage substrate that logic will eventually read
// and write through instead of the local `rooms` object.
//
// NOT WIRED IN. server.js's `rooms` object is completely untouched.
// Nothing here runs unless something explicitly requires this file —
// no merge, no behavior change.
//
// CONSISTENCY MODEL (per STEP_4.1 doc): a per-room lock
// (module4/redis/lock.js) guards every read-modify-write so two
// concurrent seat/host/mute changes on the same room — whether from
// the same instance or two different ones — serialize instead of
// racing. The state document itself is stored as ONE Redis key
// (JSON blob) sharing the room's hash tag with its lock key, via
// keyspace.roomKey() — so lock + state always live in the same
// Cluster hash slot, and moving from single-instance to Cluster later
// requires zero changes here.
//
// WHY ONE JSON BLOB PER ROOM (vs. a Redis Hash per field, or separate
// keys per seat): the whole point of the lock is atomic read-modify-
// write of the *whole room* (seats + host + moderators + mute all
// change together in practice — e.g. a host leaving reassigns both
// hostId and their seat). A single key keeps that one GET + one SET
// inside the lock, with no risk of a partial multi-key write ever
// existing mid-operation, and it stays trivially Cluster-safe since
// it's one key. The cost (rewriting the whole document on any change)
// is cheap at room-state sizes (a handful of seats + small arrays)
// and was already the correct tradeoff `redis/roomState.js` (Phase 2A)
// made for its own mirror of the same data.

const connectionFactory = require("./connectionFactory.js");
const keyspace = require("./keyspace.js");
const lock = require("./lock.js");

const LOCK_TTL_MS = parseInt(process.env.MODULE4_ROOM_LOCK_TTL_MS || "5000", 10);

let client = null;

function init() {
    if (client) return;
    client = connectionFactory.createClient("module4-roomState");
    if (!client) {
        console.warn("[module4/roomState] Redis unavailable — room state calls will no-op");
    }
}

function isEnabled() {
    return !!client;
}

// Shape mirrors server.js's in-memory room object (see loadRooms()),
// trimmed to the fields this step covers: room identity, host,
// moderators, seats, mute state. Fields server.js has that aren't
// listed here (messages, music, videoPlaylist, treasureChest, etc.)
// are deliberately out of scope for Step 4.3 — they weren't in the
// Step 4.1 migration order and adding them here would be scope creep
// into business logic this file isn't meant to own.
function defaultRoomState(roomId, seatCount = 8) {
    return {
        roomId,
        hostId: null,
        adminIds: [],       // moderators — same field name as server.js
        seats: Array(seatCount).fill(null),
        mutedUntil: {},      // userId -> timestamp, same shape as server.js
        updatedAt: new Date().toISOString(),
        version: 0,          // increments on every write; useful for callers
                              // that want to detect "did this change under me"
                              // without relying on updatedAt string comparison
    };
}

async function getRoomState(roomId) {
    if (!client) return null;
    try {
        const raw = await client.get(keyspace.roomKey(roomId, "state"));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.warn(`[module4/roomState] getRoomState failed for ${roomId}: ${e.message}`);
        return null;
    }
}

// Creates the room's state document only if it doesn't already exist
// (NX) — safe to call speculatively without clobbering a room another
// instance already initialized.
async function initRoomState(roomId, overrides = {}) {
    if (!client) return false;
    try {
        const state = { ...defaultRoomState(roomId), ...overrides, roomId };
        const res = await client.set(
            keyspace.roomKey(roomId, "state"),
            JSON.stringify(state),
            "NX"
        );
        return res === "OK";
    } catch (e) {
        console.warn(`[module4/roomState] initRoomState failed for ${roomId}: ${e.message}`);
        return false;
    }
}

// Generic lock-protected read-modify-write. `updaterFn(currentState)`
// receives the current state (or a fresh default if none exists yet)
// and must return the new state to persist. This is the one primitive
// every specific helper below is built on — kept generic so future
// fields (once someone decides to migrate them) don't need a new
// locking pattern, just a new updaterFn.
async function updateRoomState(roomId, updaterFn, { seatCount = 8 } = {}) {
    if (!client) return null;
    const key = keyspace.roomKey(roomId, "state");
    const lockKey = keyspace.roomKey(roomId, "lock");
    return lock.withLock(client, lockKey, { ttlMs: LOCK_TTL_MS }, async () => {
        const raw = await client.get(key);
        const current = raw ? JSON.parse(raw) : defaultRoomState(roomId, seatCount);
        const next = await updaterFn(current);
        next.updatedAt = new Date().toISOString();
        next.version = (current.version || 0) + 1;
        await client.set(key, JSON.stringify(next));
        return next;
    });
}

async function deleteRoomState(roomId) {
    if (!client) return false;
    try {
        await client.del(keyspace.roomKey(roomId, "state"));
        return true;
    } catch (e) {
        console.warn(`[module4/roomState] deleteRoomState failed for ${roomId}: ${e.message}`);
        return false;
    }
}

// ---- Specific helpers (thin wrappers over updateRoomState) ----
// Each is a small, obvious patch — no eligibility/permission rules.
// Whether a user is ALLOWED to become host, moderate, sit, or be
// muted is a server.js business-logic decision made before calling
// these; these just persist the outcome.

async function setHost(roomId, hostId) {
    return updateRoomState(roomId, (state) => {
        state.hostId = hostId;
        return state;
    });
}

async function addModerator(roomId, userId) {
    return updateRoomState(roomId, (state) => {
        if (!state.adminIds.includes(userId)) state.adminIds.push(userId);
        return state;
    });
}

async function removeModerator(roomId, userId) {
    return updateRoomState(roomId, (state) => {
        state.adminIds = state.adminIds.filter((id) => id !== userId);
        return state;
    });
}

async function assignSeat(roomId, seatIndex, seatData) {
    return updateRoomState(roomId, (state) => {
        if (seatIndex < 0 || seatIndex >= state.seats.length) {
            throw new Error(`seatIndex ${seatIndex} out of range for room ${roomId}`);
        }
        state.seats[seatIndex] = seatData;
        return state;
    });
}

async function clearSeat(roomId, seatIndex) {
    return updateRoomState(roomId, (state) => {
        if (seatIndex < 0 || seatIndex >= state.seats.length) {
            throw new Error(`seatIndex ${seatIndex} out of range for room ${roomId}`);
        }
        state.seats[seatIndex] = null;
        return state;
    });
}

async function muteUser(roomId, userId, until) {
    return updateRoomState(roomId, (state) => {
        state.mutedUntil[userId] = until;
        return state;
    });
}

async function unmuteUser(roomId, userId) {
    return updateRoomState(roomId, (state) => {
        delete state.mutedUntil[userId];
        return state;
    });
}

async function shutdown() {
    if (client) await client.quit().catch(() => {});
    client = null;
}

module.exports = {
    init,
    isEnabled,
    getRoomState,
    initRoomState,
    updateRoomState,
    deleteRoomState,
    setHost,
    addModerator,
    removeModerator,
    assignSeat,
    clearSeat,
    muteUser,
    unmuteUser,
    shutdown,
    defaultRoomState,
};
