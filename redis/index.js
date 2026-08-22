// redis/index.js
// ==================================================
// PHASE 2A/2B-1/2B-2 — SHARED STATE FOUNDATION (orchestrator)
// ==================================================
// Single require point for the whole Redis layer, same init(deps)
// pattern as room-recovery.js / health-check.js so wiring it into
// server.js is one small additive block, not a rewrite.
//
// WHAT THIS ADDS TO THE RUNNING APP (Phase 2A, unchanged)
//   - A periodic snapshot loop (every SYNC_INTERVAL_MS) that mirrors
//     `rooms` and `socketsByUserId` into Redis via userState.js /
//     roomState.js. Read paths in server.js are NOT changed — this is
//     one-way, in-memory -> Redis, for now.
//   - One admin-gated route, GET /api/admin/redis-health, mirroring the
//     shape of /api/admin/health from health-check.js (Phase 1) so it's
//     a familiar dashboard call, not a new pattern to learn.
//
// WHAT PHASE 2B-1 ADDS ON TOP (see each file for detail)
//   - redis/socketAdapter.js is attached separately, directly in
//     server.js right after `io` is created — not from here, since it
//     needs to be in place before any route/socket handler registers.
//     Nothing in this orchestrator duplicates that.
//   - redis/pubsub.js's four event channels (room/voice/presence/
//     system) are initialized here and fed from THIS module's own sync
//     cycle by diffing each snapshot against the previous one — no new
//     hook into server.js's business logic was needed for this: the
//     sync cycle already visits every online user and room every 5s,
//     so noticing what changed since last time and publishing that is
//     purely additive to this file.
//   - redis/voiceState.js mirrors voice-health.js's existing
//     getGlobalSummary() into Redis per-instance, for cluster-wide
//     aggregation — voice-health.js itself is untouched.
//   - redis/clusterRead.js's cluster-wide totals are exposed via the
//     existing /api/admin/redis-health route (additive fields only).
//
// WHAT PHASE 2B-2 ADDS ON TOP (see redis/presence.js for detail)
//   - Rich presence status (online/away/busy/in_room/in_voice_call),
//     synced from this module's existing sync cycle (same 5s tick,
//     no new timer), with its own batching/debouncing so it doesn't
//     add O(n) Redis round-trips per cycle.
//   - Best-effort duplicate-session / device-switch detection
//     (informational pub/sub event only — see presence.js header for
//     why this phase doesn't auto-act on it).
//   - Immediate presence cleanup on the same online/offline diff this
//     module already computes every cycle (no new detection logic
//     needed — presence.js just reacts to it).
//   - "Multi-Instance Room Synchronization" (room members/seats/host/
//     mute/voice participants) and "Cross-Instance Recovery" needed NO
//     new code: the Socket.IO Redis Adapter (2B-1) already makes every
//     existing io.to(roomId).emit(...) in server.js cross-instance for
//     live events, roomState.js (2A) already mirrors the same fields
//     for cluster-wide snapshot reads, and TTL self-expiry (2A) already
//     handles a crashed instance's state disappearing without an
//     active cleanup step. See PHASE_2B2_REPORT.md for the full
//     verification of why each of those was already sufficient.
// STILL NOT DONE (honest scope note, unchanged from Phase 2A)
//   - server.js's own hot-path reads (`rooms[roomId]`, etc.) are not
//     replaced by Redis reads — see redis/clusterRead.js's header for
//     why that's a deliberate choice, not an oversight.
//   - No clustering/SFU — still out of scope.
//
// IF REDIS ISN'T CONFIGURED: every module here degrades to a no-op (see
// redis/client.js's safety contract). This orchestrator still starts
// its interval timer either way, but each tick is a fast no-op check
// against `client.isEnabled()`, so there's no meaningful overhead and
// no behavior change when Redis is absent.

const client = require("./client.js");
const cache = require("./cache.js");
const userState = require("./userState.js");
const roomState = require("./roomState.js");
const sessionStore = require("./sessionStore.js");
const pubsub = require("./pubsub.js");
const voiceState = require("./voiceState.js");
const clusterRead = require("./clusterRead.js");
const presence = require("./presence.js"); // Phase 2B-2

const SYNC_INTERVAL_MS = 5000;
// System heartbeat is far lower-frequency than the state sync itself —
// it's an ops/observability signal ("this instance is alive, here's its
// shape"), not something anything currently reacts to in real time, so
// there's no reason to publish it every 5s.
const SYSTEM_HEARTBEAT_EVERY_N_CYCLES = 6; // ~every 30s at the default interval

function initRedisLayer({ app, requireAdmin, rooms, socketsByUserId, io, voiceHealth, APP_NAME }) {
    let syncTimer = null;
    let lastSyncAt = null;
    let lastSyncError = null;
    let syncCount = 0;

    // Previous-cycle snapshots, used only to diff against the current
    // cycle so genuine "user came online/went offline" and "room
    // created/removed" events can be published — never read by
    // anything else, never mutated by anything else. Local to this
    // closure, not shared/exported.
    let prevOnlineUserIds = new Set();
    let prevRoomIds = new Set();

    // Tiny, non-authoritative view of what pub/sub has told this
    // instance about the rest of the cluster — purely for the admin
    // dashboard's visibility. Never consulted by, and never written to
    // by, any business logic (rooms/socketsByUserId stay the only
    // source of truth for everything that actually runs the app).
    const remoteInstances = new Map(); // instanceId -> { lastSeenAt, ...payload }

    // Phase 2B-2: same observability-only rule as remoteInstances above —
    // a small bounded buffer of recent cross-instance presence events for
    // the admin dashboard, never consulted by any business logic.
    const recentDuplicateSessions = [];
    let presenceEventCount = 0;

    function publishDiffEvents() {
        const onlineUserIds = new Set(Object.keys(socketsByUserId));
        for (const userId of onlineUserIds) {
            if (!prevOnlineUserIds.has(userId)) pubsub.publish("presence", "user-online", { userId });
        }
        for (const userId of prevOnlineUserIds) {
            if (!onlineUserIds.has(userId)) {
                pubsub.publish("presence", "user-offline", { userId });
                // Phase 2B-2: don't wait out presence.js's own TTL for a
                // user this instance just watched go offline — remove
                // their cluster-visible presence record immediately.
                presence.clearUser(userId).catch(() => {});
            }
        }
        prevOnlineUserIds = onlineUserIds;

        const roomIds = new Set(Object.keys(rooms));
        for (const roomId of roomIds) {
            if (!prevRoomIds.has(roomId)) pubsub.publish("room", "room-created", { roomId });
        }
        for (const roomId of prevRoomIds) {
            if (!roomIds.has(roomId)) pubsub.publish("room", "room-removed", { roomId });
        }
        prevRoomIds = roomIds;
    }

    async function runSyncCycle() {
        if (!client.isEnabled()) return;
        try {
            const deps = { rooms, socketsByUserId, io };
            await Promise.all([
                userState.syncAll(deps),
                roomState.syncAll(deps),
                voiceState.syncGlobal(voiceHealth),
                presence.syncAll(deps), // Phase 2B-2 — see redis/presence.js
            ]);
            publishDiffEvents();
            syncCount++;
            if (syncCount % SYSTEM_HEARTBEAT_EVERY_N_CYCLES === 0) {
                pubsub.publish("system", "instance-heartbeat", {
                    uptimeSec: Math.round(process.uptime()),
                    onlineUsers: Object.keys(socketsByUserId).length,
                    activeRooms: Object.keys(rooms).length,
                });
            }
            lastSyncAt = new Date().toISOString();
            lastSyncError = null;
        } catch (e) {
            lastSyncError = e.message;
            console.warn(`[redis/index] sync cycle failed: ${e.message}`);
        }
    }

    if (client.isEnabled()) {
        pubsub.init();
        // Passive listeners only — update the observability map above,
        // never touch rooms/socketsByUserId. See remoteInstances' own
        // comment for why that boundary matters.
        pubsub.on("system", (msg) => {
            remoteInstances.set(msg.instanceId, { lastSeenAt: new Date().toISOString(), ...msg.payload });
        });
        // Phase 2B-2: presence.js now actually publishes on this channel
        // ("status-changed", "duplicate-session-detected"). This listener
        // is still passive/observability-only — same rule as remoteInstances
        // above, it never touches rooms/socketsByUserId or acts on a
        // duplicate-session report, it just makes recent ones visible to
        // the admin dashboard via the route below.
        pubsub.on("presence", (msg) => {
            if (msg.event === "duplicate-session-detected") {
                recentDuplicateSessions.push({ ...msg.payload, ts: msg.ts });
                if (recentDuplicateSessions.length > 50) recentDuplicateSessions.shift();
            }
            presenceEventCount++;
        });
        pubsub.on("room", () => {});     // reserved for a future cluster-wide room directory; safe no-op today
        pubsub.on("voice", () => {});    // reserved — voiceState.js's Redis mirror already covers the aggregate case

        syncTimer = setInterval(runSyncCycle, SYNC_INTERVAL_MS);
        syncTimer.unref();
        runSyncCycle(); // don't wait a full interval for the first snapshot
        console.log(`[redis/index] state sync loop started (every ${SYNC_INTERVAL_MS}ms)`);
    }

    // Additive route — same shape/gating as health-check.js's
    // /api/admin/health so it drops straight into the existing admin
    // dashboard pattern. Route name checked against server.js's full
    // route table before adding: no collision. Phase 2B-1 only adds new
    // fields to the existing response shape (clusterTotals,
    // clusterVoiceHealth, remoteInstances, pubsub); nothing already
    // relied upon by a client was removed or renamed.
    if (app && requireAdmin) {
        app.get("/api/admin/redis-health", requireAdmin, async (req, res) => {
            const [clusterTotals, clusterVoiceHealth] = await Promise.all([
                clusterRead.getClusterTotals(),
                voiceState.getClusterVoiceHealth(),
            ]);
            res.json({
                success: true,
                service: APP_NAME || "server",
                redis: client.getHealth(),
                sync: {
                    intervalMs: SYNC_INTERVAL_MS,
                    lastSyncAt,
                    lastSyncError,
                    syncCount,
                    roomsTracked: Object.keys(rooms).length,
                    usersTracked: Object.keys(socketsByUserId).length,
                },
                cluster: {
                    thisInstanceId: pubsub.INSTANCE_ID,
                    totals: clusterTotals,
                    voiceHealth: clusterVoiceHealth,
                    remoteInstances: Array.from(remoteInstances.entries()).map(([instanceId, data]) => ({ instanceId, ...data })),
                },
                presence: {
                    // Phase 2B-2 — additive fields only, nothing above this
                    // object in the response changed shape.
                    crossInstanceEventCount: presenceEventCount,
                    recentDuplicateSessions,
                },
            });
        });
    }

    return {
        client,
        cache,
        userState,
        roomState,
        sessionStore,
        pubsub,
        voiceState,
        clusterRead,
        presence,
        getStatus: () => ({ enabled: client.isEnabled(), lastSyncAt, lastSyncError, syncCount }),
    };
}

module.exports = { initRedisLayer };
