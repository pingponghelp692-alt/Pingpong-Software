// redis/presence.js
// ==================================================
// PHASE 2B-2 — GLOBAL PRESENCE & DISTRIBUTED USER STATE
// ==================================================
// Additive on top of Phase 2A's redis/userState.js, not a replacement or
// a rewrite of it. userState.js already mirrors the raw signals this
// module needs (online / currentRoom / currentSeat / inCall) — see its
// own header. This module owns a DIFFERENT, narrower concern: turning
// those raw signals (plus an optional manual override) into the richer
// status vocabulary Phase 2B-2 asks for (online / offline / away / busy
// / in_room / in_voice_call), publishing cluster-visible transitions,
// and doing the write-path optimizations (batching/debouncing) that
// userState.js's own Phase 2A design deliberately didn't need at the
// time. userState.js is untouched by this file.
//
// OWN KEY NAMESPACE (same "one module, one key prefix" convention
// roomState.js/userState.js/voiceState.js already established):
//   presence:user:{userId}       hash — status, previousStatus,
//                                 instanceId, socketId, source, updatedAt
//   presence:override:{userId}   hash — manual away/busy override, its
//                                 own short TTL so a crash/forgotten
//                                 clear can't pin a user "busy" forever
//
// STATUS DERIVATION (auto, every sync cycle, same read-only inputs
// userState.js already uses — never mutates rooms/socketsByUserId/io):
//   not in socketsByUserId at all         -> not written (treated as
//                                             offline; key left to expire
//                                             / explicitly deleted, see
//                                             cleanup below)
//   online, no room                       -> "online"
//   online, in a room, not seated          -> "in_room"
//   online, seated (= voice connected)     -> "in_voice_call"
//   manual override active (away/busy)     -> overrides the auto value
//                                             above until cleared or the
//                                             user goes offline
//
// WRITE-PATH OPTIMIZATION (the "Presence Optimization" requirement):
//   - BATCHING: one Redis pipeline for the whole cycle's worth of
//     presence writes, instead of one round-trip per user (contrast
//     with userState.js's existing per-user sequential await loop,
//     which Phase 2A already shipped and this phase was told not to
//     rewrite).
//   - DEBOUNCING: a user whose computed status hasn't changed since the
//     last cycle is skipped entirely, except once every
//     HEARTBEAT_EVERY_N_CYCLES cycles (still batched) purely to refresh
//     its TTL. In steady state (most users' status is stable between
//     5s ticks) this cuts presence-related Redis writes by roughly the
//     same factor as the heartbeat interval.
//   - TTL CLEANUP: presence/override keys self-expire (EX), same
//     pattern as every other redis/*.js mirror. On top of that, a user
//     who goes offline is detected the very next cycle (no longer in
//     socketsByUserId) and both of their keys are deleted immediately
//     — the cluster doesn't have to wait out the TTL to stop seeing a
//     just-logged-out user as present.
//
// DUPLICATE LOGIN / DEVICE-SWITCH DETECTION (best-effort, read-only):
//   Before writing this instance's view of a user, the previous
//   cluster-wide record is read. If it shows the SAME userId currently
//   owned by a DIFFERENT instanceId+socketId, that's surfaced as a
//   "duplicate-session-detected" pub/sub event (presence category) —
//   informational only. This module never disconnects, kicks, or
//   invalidates anything; deciding what to do about a duplicate session
//   is a login/business-logic decision explicitly out of scope for this
//   phase (see PHASE_2B2_REPORT.md). A normal same-device reconnect
//   also flips instanceId/socketId, so this is a signal to surface, not
//   a certainty to act on automatically.
//
// SAFETY CONTRACT: identical to the rest of redis/ — every function is
// a no-op / resolves to null/false if Redis is disabled, nothing here
// ever throws out of its public functions, and nothing here is on any
// hot path (it's driven entirely by redis/index.js's existing interval,
// same as userState.js/roomState.js/voiceState.js already are).

const client = require("./client.js");
const pubsub = require("./pubsub.js");

const PRESENCE_TTL_SECONDS = 90; // same lifetime as userState.js's mirror
const OVERRIDE_TTL_SECONDS = 24 * 60 * 60; // manual away/busy self-clears within a day even if never explicitly cleared
const HEARTBEAT_EVERY_N_CYCLES = 6; // ~every 30s at the default 5s sync interval — matches redis/index.js's own system-heartbeat cadence
const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;

const STATUSES = Object.freeze({
    ONLINE: "online",
    OFFLINE: "offline",
    AWAY: "away",
    BUSY: "busy",
    IN_ROOM: "in_room",
    IN_VOICE_CALL: "in_voice_call",
});
const MANUAL_STATUSES = new Set([STATUSES.AWAY, STATUSES.BUSY]);

function presenceKey(userId) {
    return client.prefixed(`presence:user:${userId}`);
}
function overrideKey(userId) {
    return client.prefixed(`presence:override:${userId}`);
}

// Local (per-instance, in-process) bookkeeping only — never read by
// anything outside this file, mirrors the same "closure-local, not
// shared/exported" approach redis/index.js already uses for its own
// diff-tracking Sets.
let lastWrittenStatus = new Map(); // userId -> last status actually written to Redis
let cycleCounter = 0;

// ---------------- manual away/busy override ----------------
// Written immediately (not batched) since this is a direct user action
// via a socket event, not a periodic snapshot — matching how any other
// user-triggered write in this app happens synchronously with the
// event that caused it. Safe no-op if Redis is disabled.
async function setOverride(userId, status) {
    if (!MANUAL_STATUSES.has(status)) return false;
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        const multi = conn.multi();
        multi.hset(overrideKey(userId), { status, setAt: new Date().toISOString(), instanceId: INSTANCE_ID });
        multi.expire(overrideKey(userId), OVERRIDE_TTL_SECONDS);
        await multi.exec();
        return true;
    } catch (e) {
        console.warn(`[redis/presence] setOverride(${userId}) failed: ${e.message}`);
        return false;
    }
}

async function clearOverride(userId) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        await conn.del(overrideKey(userId));
        return true;
    } catch (e) {
        console.warn(`[redis/presence] clearOverride(${userId}) failed: ${e.message}`);
        return false;
    }
}

// ---------------- status computation ----------------
// Read-only derivation from the exact same in-memory sources
// userState.js already reads (io/rooms/socketsByUserId) — this
// function never mutates any of them.
function computeAutoStatus(userId, { io, rooms, socketsByUserId }) {
    const socketId = socketsByUserId[userId];
    if (!socketId) return null; // not online on this instance right now
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return null;

    const roomId = socket.currentRoom || "";
    if (roomId && rooms[roomId]) {
        const seats = rooms[roomId].seats || [];
        const seated = seats.some((s) => s && s.userId === userId);
        return { status: seated ? STATUSES.IN_VOICE_CALL : STATUSES.IN_ROOM, socketId };
    }
    return { status: STATUSES.ONLINE, socketId };
}

// ---------------- batched, debounced sync cycle ----------------
// Called once per redis/index.js sync tick, same wiring pattern as
// userState.syncAll/roomState.syncAll/voiceState.syncGlobal. Everything
// below is a single pipeline of reads followed by a single pipeline of
// writes — O(1) round trips for the whole online-user set instead of
// O(n), which is the concrete "batching" this phase asked for.
async function syncAll(deps) {
    if (!client.isEnabled()) return;
    const { socketsByUserId } = deps;
    const conn = client.getConnection();
    if (!conn) return;

    cycleCounter++;
    const isHeartbeatCycle = cycleCounter % HEARTBEAT_EVERY_N_CYCLES === 0;
    const onlineUserIds = Object.keys(socketsByUserId);
    const onlineSet = new Set(onlineUserIds);

    // Immediate cleanup: anyone this instance last wrote as present but
    // is no longer locally online gets removed from local bookkeeping.
    // (Their Redis key is left to whichever instance still has them
    // online to keep refreshing, or to expire naturally if truly gone —
    // this instance can only speak authoritatively for its own users.)
    for (const userId of Array.from(lastWrittenStatus.keys())) {
        if (!onlineSet.has(userId)) lastWrittenStatus.delete(userId);
    }

    if (!onlineUserIds.length) return;

    // ---- read pass: prior cluster record (for duplicate-session
    // detection) + any manual override, batched into one pipeline ----
    let priorRecords = [];
    let overrides = [];
    try {
        const readPipeline = conn.pipeline();
        for (const userId of onlineUserIds) {
            readPipeline.hgetall(presenceKey(userId));
            readPipeline.hgetall(overrideKey(userId));
        }
        const results = await readPipeline.exec(); // [[err, val], ...] in call order
        for (let i = 0; i < onlineUserIds.length; i++) {
            const priorRaw = results[i * 2];
            const overrideRaw = results[i * 2 + 1];
            priorRecords.push(priorRaw && !priorRaw[0] && Object.keys(priorRaw[1] || {}).length ? priorRaw[1] : null);
            overrides.push(overrideRaw && !overrideRaw[0] && Object.keys(overrideRaw[1] || {}).length ? overrideRaw[1] : null);
        }
    } catch (e) {
        console.warn(`[redis/presence] read pipeline failed: ${e.message}`);
        return; // don't guess at duplicate-session state from a partial read
    }

    // ---- compute effective status per user, decide who actually needs
    // a write this cycle (debouncing) ----
    const toWrite = []; // { userId, status, socketId }
    const duplicates = []; // { userId, thisInstanceId, otherInstanceId }
    for (let i = 0; i < onlineUserIds.length; i++) {
        const userId = onlineUserIds[i];
        const auto = computeAutoStatus(userId, deps);
        if (!auto) continue; // stale entry in socketsByUserId (socket gone) — userState.js's own cycle handles cleanup of that map; nothing for presence to write

        const override = overrides[i];
        const status = override ? override.status : auto.status;

        const prior = priorRecords[i];
        if (prior && prior.instanceId && prior.instanceId !== INSTANCE_ID && prior.socketId !== auto.socketId) {
            duplicates.push({ userId, thisInstanceId: INSTANCE_ID, otherInstanceId: prior.instanceId });
        }

        const changed = lastWrittenStatus.get(userId) !== status;
        if (changed || isHeartbeatCycle) {
            toWrite.push({ userId, status, socketId: auto.socketId, previousStatus: lastWrittenStatus.get(userId) || null });
        }
    }

    if (toWrite.length) {
        try {
            const writePipeline = conn.pipeline();
            const now = new Date().toISOString();
            for (const entry of toWrite) {
                writePipeline.hset(presenceKey(entry.userId), {
                    status: entry.status,
                    previousStatus: entry.previousStatus || "",
                    instanceId: INSTANCE_ID,
                    socketId: entry.socketId,
                    updatedAt: now,
                });
                writePipeline.expire(presenceKey(entry.userId), PRESENCE_TTL_SECONDS);
            }
            await writePipeline.exec();
            for (const entry of toWrite) {
                if (entry.previousStatus !== entry.status) {
                    pubsub.publish("presence", "status-changed", { userId: entry.userId, status: entry.status, previousStatus: entry.previousStatus });
                }
                lastWrittenStatus.set(entry.userId, entry.status);
            }
        } catch (e) {
            console.warn(`[redis/presence] write pipeline failed: ${e.message}`);
        }
    }

    for (const dup of duplicates) {
        pubsub.publish("presence", "duplicate-session-detected", dup);
    }
}

// Explicit removal, called by redis/index.js when it notices (via its
// own existing online/offline diff) that a user just went offline —
// faster than waiting out PRESENCE_TTL_SECONDS.
async function clearUser(userId) {
    if (!client.isEnabled()) return;
    const conn = client.getConnection();
    if (!conn) return;
    try {
        await conn.del(presenceKey(userId), overrideKey(userId));
    } catch (e) {
        console.warn(`[redis/presence] clearUser(${userId}) failed: ${e.message}`);
    }
    lastWrittenStatus.delete(userId);
}

// ---------------- reads ----------------
async function getPresence(userId) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    try {
        const data = await conn.hgetall(presenceKey(userId));
        return Object.keys(data).length ? data : null;
    } catch (e) {
        console.warn(`[redis/presence] getPresence(${userId}) failed: ${e.message}`);
        return null;
    }
}

// Batched multi-user read (one pipeline instead of N awaits) — for
// admin dashboards / future features that need several users' presence
// at once rather than one at a time.
async function getClusterPresenceBatch(userIds) {
    if (!client.isEnabled() || !userIds || !userIds.length) return {};
    const conn = client.getConnection();
    if (!conn) return {};
    try {
        const pipeline = conn.pipeline();
        for (const userId of userIds) pipeline.hgetall(presenceKey(userId));
        const results = await pipeline.exec();
        const out = {};
        userIds.forEach((userId, i) => {
            const r = results[i];
            out[userId] = r && !r[0] && Object.keys(r[1] || {}).length ? r[1] : null;
        });
        return out;
    } catch (e) {
        console.warn(`[redis/presence] getClusterPresenceBatch failed: ${e.message}`);
        return {};
    }
}

module.exports = {
    STATUSES,
    setOverride,
    clearOverride,
    syncAll,
    clearUser,
    getPresence,
    getClusterPresenceBatch,
};
