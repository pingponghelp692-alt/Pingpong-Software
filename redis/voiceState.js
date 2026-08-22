// redis/voiceState.js
// ==================================================
// PHASE 2B-1 — CLUSTER-WIDE VOICE HEALTH (mirror)
// ==================================================
// voice-health.js (Phase 1) intentionally keeps its `connectionStats`/
// `roomSummaries` state in-memory-only, per-instance, and its own file
// header says explicitly: "If a truly cluster-wide health view is
// wanted later, aggregate at the Redis/monitor.js layer rather than
// changing how this module collects samples." This module is exactly
// that follow-up, and it does not touch voice-health.js at all — it
// only reads the two query functions it already exposes
// (getGlobalSummary/getRoomHealth) on an interval and mirrors the
// result into Redis, same polling-snapshot pattern as userState.js /
// roomState.js.
//
// STORED: one key per instance (`voice:instance:{instanceId}`, JSON,
// short TTL) rather than one shared key, so instances never overwrite
// each other's numbers — getClusterVoiceHealth() below sums across all
// of them. TTL is intentionally short (30s, vs 90s for user/room state)
// because voice quality is only meaningful "live"; a crashed instance's
// stale numbers should drop out of the cluster total quickly rather
// than linger and skew it.

const client = require("./client.js");

const STATE_TTL_SECONDS = 30;
const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;

function instanceVoiceKey() {
    return client.prefixed(`voice:instance:${INSTANCE_ID}`);
}

async function syncGlobal(voiceHealth) {
    if (!client.isEnabled() || !voiceHealth) return;
    const conn = client.getConnection();
    if (!conn) return;
    try {
        const summary = voiceHealth.getGlobalSummary();
        await conn.set(
            instanceVoiceKey(),
            JSON.stringify({ ...summary, instanceId: INSTANCE_ID, updatedAt: new Date().toISOString() }),
            "EX", STATE_TTL_SECONDS
        );
    } catch (e) {
        console.warn(`[redis/voiceState] syncGlobal failed: ${e.message}`);
    }
}

// Cluster-wide aggregate across every instance currently reporting.
// Returns null (not an empty object) when Redis is disabled or nothing
// has reported yet, so callers can distinguish "no cluster data" from
// "cluster data says zero" and fall back to this instance's own
// voiceHealth.getGlobalSummary() in the former case. SCAN-based, same
// non-blocking pattern as redis/cache.js's invalidateNamespace — safe
// even if the cluster grows large.
async function getClusterVoiceHealth() {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    const pattern = client.prefixed("voice:instance:*");
    let cursor = "0";
    const keys = [];
    try {
        do {
            const [next, batch] = await conn.scan(cursor, "MATCH", pattern, "COUNT", 200);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== "0");
        if (!keys.length) return null;
        const raws = await Promise.all(keys.map((k) => conn.get(k)));
        const instances = raws.filter(Boolean).map((r) => JSON.parse(r));
        if (!instances.length) return null;
        return instances.reduce((acc, s) => ({
            good: acc.good + (s.good || 0),
            fair: acc.fair + (s.fair || 0),
            poor: acc.poor + (s.poor || 0),
            activeRooms: acc.activeRooms + (s.activeRooms || 0),
            trackedConnections: acc.trackedConnections + (s.trackedConnections || 0),
            instances: acc.instances + 1,
        }), { good: 0, fair: 0, poor: 0, activeRooms: 0, trackedConnections: 0, instances: 0 });
    } catch (e) {
        console.warn(`[redis/voiceState] getClusterVoiceHealth failed: ${e.message}`);
        return null;
    }
}

module.exports = { syncGlobal, getClusterVoiceHealth, STATE_TTL_SECONDS };
