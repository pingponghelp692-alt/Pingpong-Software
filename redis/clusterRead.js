// redis/clusterRead.js
// ==================================================
// PHASE 2B-1 — CROSS-INSTANCE READ PATH
// ==================================================
// "Move runtime read operations to Redis where appropriate" — the
// appropriate case, and the ONLY case handled here, is a read that
// in-memory genuinely cannot answer: whether a piece of state exists on
// a DIFFERENT instance than the one handling the current request. Every
// existing local read in this codebase (`rooms[roomId]`,
// `socketsByUserId[userId]`, etc.) is completely untouched and stays
// the fast, synchronous, zero-latency path for anything on this
// instance — these helpers are only ever a fallback a caller reaches
// for after already checking locally and getting nothing.
//
// WHY NOT REPLACE THE EXISTING LOCAL READS: `rooms`/`socketsByUserId`
// are mutated synchronously, many times per request, throughout a
// 6,000+ line file that this phase was explicitly told not to rewrite.
// The Redis mirrors (userState.js/roomState.js, Phase 2A) are eventually
// consistent on a 5s sync interval with a 90s TTL — correct for "does
// this exist somewhere in the cluster right now, approximately", wrong
// for "read this room's live seat state for the request I'm handling
// this millisecond". Swapping the latter to Redis would be a strict
// downgrade in correctness and latency for zero benefit on a
// single-instance deployment (today's reality) and a real regression
// risk on a multi-instance one. So: local stays local; only the
// cluster-wide question moves to Redis.

const client = require("./client.js");
const userState = require("./userState.js");
const roomState = require("./roomState.js");

// Assumes the caller already checked local state first and is asking
// "is this user online on some OTHER instance?". Same return shape as
// userState.getUserState (null if nowhere in the cluster / Redis
// disabled).
async function findUserAcrossCluster(userId) {
    return userState.getUserState(userId);
}

// Same idea for a room. Same return shape as roomState.getRoomState.
async function getRoomAcrossCluster(roomId) {
    return roomState.getRoomState(roomId);
}

// SCAN-based count of keys under a prefix — never blocks Redis, same
// pattern as redis/cache.js's invalidateNamespace and
// redis/voiceState.js's getClusterVoiceHealth.
async function scanCount(matchPattern) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    let cursor = "0";
    let count = 0;
    try {
        do {
            const [next, keys] = await conn.scan(cursor, "MATCH", matchPattern, "COUNT", 200);
            cursor = next;
            count += keys.length;
        } while (cursor !== "0");
        return count;
    } catch (e) {
        console.warn(`[redis/clusterRead] scanCount(${matchPattern}) failed: ${e.message}`);
        return null;
    }
}

// Cluster-wide online-user / active-room totals — the field
// health-check.js's own header already flagged as "will need widening
// later... that aggregation belongs in monitor.js reading from Redis,
// not here". This is that aggregation. Each instance's per-instance
// numbers (already in /api/admin/health) are unchanged; this is an
// additive cluster-wide total exposed alongside them via
// /api/admin/redis-health, not a replacement.
async function getClusterTotals() {
    if (!client.isEnabled()) return null;
    const [onlineUsersCluster, activeRoomsCluster] = await Promise.all([
        scanCount(client.prefixed("user:state:*")),
        scanCount(client.prefixed("room:state:*")),
    ]);
    return { onlineUsersCluster, activeRoomsCluster };
}

module.exports = { findUserAcrossCluster, getRoomAcrossCluster, getClusterTotals };
