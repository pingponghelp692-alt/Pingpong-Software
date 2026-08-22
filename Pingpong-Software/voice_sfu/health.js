// voice_sfu/health.js
// ==================================================
// PHASE 3, STEP 3.2 — SFU HEALTH METRICS (EXTENDS, DOES NOT REPLACE)
// ==================================================
// Per spec requirement #9 ("Extend voice-health. Do not replace it. Add
// SFU metrics only."), this file does NOT modify voice-health.js. It
// wraps it: getCombinedHealth() below calls the EXISTING
// voiceHealth.getGlobalSummary()/getRoomHealth() (passed in at init,
// unchanged) and merges in a second, independent metrics section for
// SFU join/leave/error counts. Mesh telemetry keeps flowing through
// voice-health.js exactly as before; nothing here intercepts or
// duplicates it.
//
// Same "bounded, ephemeral, in-memory, per-instance" trust/lifecycle
// model voice-health.js documents for its own state — SFU health here
// is ops/dashboard telemetry, not an authorization or billing source of
// truth (LiveKit's own API remains authoritative for that, see
// livekit.js).

const MAX_EVENTS = 200; // bounded ring buffer, same spirit as voice-health.js's MAX_SAMPLES_PER_CONNECTION

function initSfuHealth({ voiceHealth, roomManager }) {
    const events = []; // { t, type: 'join'|'leave'|'error', roomId, userId, message? }
    let joinCount = 0;
    let leaveCount = 0;
    let errorCount = 0;

    // PHASE 3, STEP 3.4 additions — extends this file's existing counters
    // (does not touch voice-health.js, per this file's own header) to cover
    // the Step 3.4 spec's health-monitoring list: token generation
    // failures (tracked separately from generic errorCount so an operator
    // can tell "LiveKit is misconfigured/down" apart from a one-off relay
    // error), reconnect-grace events (mirrors the count voice-reconnect.js
    // already tracks for mesh, as the SFU-side echo of the same signal),
    // LiveKit API latency (bounded rolling sample, same MAX_EVENTS-style
    // bound as `events` above), and a count of automatic cleanups
    // (Step 3.4 §7 — LiveKit rooms deleted by voice_sfu/sync.js).
    let tokenFailureCount = 0;
    let reconnectEventCount = 0;
    let cleanupCount = 0;
    const apiLatenciesMs = []; // bounded rolling sample, most-recent-last (kept exactly as-is — existing field/behavior, see recordApiLatency below)

    // PHASE 3, STEP 3.6 additions — spec item 4 ("Monitoring improvements
    // ... token latency, LiveKit API latency, join latency, reconnect
    // latency, permission update latency, room cleanup latency"). Extends
    // health.js's existing single apiLatenciesMs bucket with the SAME
    // bounded-rolling-sample pattern, broken out per operation category,
    // rather than replacing it — apiLatenciesMs keeps recording every
    // LiveKit API call exactly as it did in Step 3.4/3.5 (nothing that
    // reads that field breaks), while these new buckets ALSO capture the
    // same measurements, categorized, for finer-grained dashboards.
    const categorizedLatenciesMs = {
        token: [], join: [], permissionUpdate: [], cleanup: [], reconnect: [], livekitApi: []
    };
    const MAX_CATEGORY_SAMPLES = 200; // same bound as MAX_EVENTS/apiLatenciesMs

    function record(type, { roomId, userId, message } = {}) {
        if (type === "join") joinCount++;
        else if (type === "leave") leaveCount++;
        else if (type === "error") errorCount++;
        events.push({ t: Date.now(), type, roomId, userId, message: message ? String(message).slice(0, 300) : undefined });
        if (events.length > MAX_EVENTS) events.shift();
    }

    function recordJoin({ roomId, userId } = {}) { record("join", { roomId, userId }); }
    function recordLeave({ roomId, userId } = {}) { record("leave", { roomId, userId }); }
    function recordError({ roomId, userId, message } = {}) { record("error", { roomId, userId, message }); }
    function recordTokenFailure({ roomId, userId, message } = {}) { tokenFailureCount++; record("error", { roomId, userId, message: message ? `[token] ${message}` : "[token] generation failed" }); }
    function recordReconnectEvent() { reconnectEventCount++; }
    function recordCleanup({ roomId } = {}) { cleanupCount++; record("cleanup", { roomId }); }
    // PHASE 3, STEP 3.6: unchanged signature/behavior for existing callers
    // that pass only `ms` (still records into apiLatenciesMs exactly as
    // before). The optional second arg lets a caller ALSO categorize the
    // same measurement into categorizedLatenciesMs — additive, opt-in.
    function recordApiLatency(ms, category) {
        if (!Number.isFinite(ms)) return;
        apiLatenciesMs.push(ms);
        if (apiLatenciesMs.length > MAX_EVENTS) apiLatenciesMs.shift();
        if (category && Object.prototype.hasOwnProperty.call(categorizedLatenciesMs, category)) {
            const arr = categorizedLatenciesMs[category];
            arr.push(ms);
            if (arr.length > MAX_CATEGORY_SAMPLES) arr.shift();
        }
    }

    // PHASE 3, STEP 3.6 additions — dedicated wrappers for the two
    // latency measurements that don't naturally flow through sync.js's
    // safe()/recordApiLatency path (token minting and the full /join
    // round trip both happen in voice_sfu/index.js's REST handler, not
    // in a sync.js hook). Kept as thin, explicitly-named functions
    // (matching this file's existing recordJoin/recordLeave/recordError
    // style) rather than a generic "record(category, ms)" the caller has
    // to know the right string for.
    function recordTokenLatency(ms) { if (Number.isFinite(ms)) { categorizedLatenciesMs.token.push(ms); if (categorizedLatenciesMs.token.length > MAX_CATEGORY_SAMPLES) categorizedLatenciesMs.token.shift(); } }
    function recordJoinLatency(ms) { if (Number.isFinite(ms)) { categorizedLatenciesMs.join.push(ms); if (categorizedLatenciesMs.join.length > MAX_CATEGORY_SAMPLES) categorizedLatenciesMs.join.shift(); } }

    function avgOf(arr) {
        return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    }

    function getSfuSummary() {
        // PHASE 3, STEP 3.6 — activePublishers/activeSubscribers: derived
        // straight from roomManager's existing best-effort local counts
        // (localParticipantCount, localPublisherCount — see
        // roomManager.js's own header for the trust model), summed
        // across every locally-active room. Not a new data source.
        const activeLocalRooms = roomManager.listActiveLocalRooms();
        const activePublishers = activeLocalRooms.reduce((sum, r) => sum + (r.localPublisherCount || 0), 0);
        const activeSubscribers = activeLocalRooms.reduce((sum, r) => sum + Math.max(0, (r.localParticipantCount || 0) - (r.localPublisherCount || 0)), 0);
        return {
            joinCount,
            leaveCount,
            errorCount,
            tokenFailureCount,
            reconnectEventCount,
            cleanupCount,
            // Unchanged field — same shape/meaning as Step 3.4/3.5.
            liveKitApiLatencyMs: { avg: avgOf(apiLatenciesMs), lastSampleCount: apiLatenciesMs.length },
            // New, additive: per-operation breakdown (spec item 4).
            latencyMs: {
                token: { avg: avgOf(categorizedLatenciesMs.token), lastSampleCount: categorizedLatenciesMs.token.length },
                join: { avg: avgOf(categorizedLatenciesMs.join), lastSampleCount: categorizedLatenciesMs.join.length },
                permissionUpdate: { avg: avgOf(categorizedLatenciesMs.permissionUpdate), lastSampleCount: categorizedLatenciesMs.permissionUpdate.length },
                cleanup: { avg: avgOf(categorizedLatenciesMs.cleanup), lastSampleCount: categorizedLatenciesMs.cleanup.length },
                reconnect: { avg: avgOf(categorizedLatenciesMs.reconnect), lastSampleCount: categorizedLatenciesMs.reconnect.length },
                livekitApi: { avg: avgOf(categorizedLatenciesMs.livekitApi), lastSampleCount: categorizedLatenciesMs.livekitApi.length }
            },
            activePublishers,
            activeSubscribers,
            activeLocalRooms,
            recentEvents: events.slice(-30)
        };
    }

    // Merges with the EXISTING mesh summary (voiceHealth is the same
    // object server.js already created via initVoiceHealth — passed in
    // unmodified). If voiceHealth is unavailable for any reason, mesh
    // fields simply come back empty rather than throwing, so an admin
    // dashboard calling this can't be broken by this module.
    function getCombinedHealth() {
        let mesh = { good: 0, fair: 0, poor: 0, activeRooms: 0, trackedConnections: 0 };
        try {
            if (voiceHealth && typeof voiceHealth.getGlobalSummary === "function") {
                mesh = voiceHealth.getGlobalSummary();
            }
        } catch (e) {
            // never let a mesh-health read failure break the SFU health response
        }
        // PHASE 3, STEP 3.5: voiceMode can now also report "staged" (see
        // rollout.js) — this is purely an added possible value on an
        // already-admin-only JSON field (GET /api/admin/voice-sfu/health,
        // unchanged route/shape); no existing consumer reads this field
        // today (Step 3.3's own note: no admin-panel UI was built to
        // display these fields yet), so widening it here is additive, not
        // a breaking change to any real caller. rolloutConfig is included
        // only when staged, so a plain mesh/sfu deployment's health JSON
        // is byte-identical to before this step.
        const rollout = require("./rollout.js");
        const baseMode = rollout.rawBaseMode();
        const result = { mesh, sfu: getSfuSummary(), voiceMode: baseMode };
        if (baseMode === "staged") result.rolloutConfig = rollout.getStagedConfigSnapshot();
        return result;
    }

    return {
        recordJoin, recordLeave, recordError, getSfuSummary, getCombinedHealth,
        recordTokenFailure, recordReconnectEvent, recordCleanup, recordApiLatency,
        recordTokenLatency, recordJoinLatency // PHASE 3, STEP 3.6
    };
}

module.exports = { initSfuHealth };
