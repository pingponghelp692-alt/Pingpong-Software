// health-check.js
// ==================================================
// PHASE 1 (Tier A) — HEALTH CHECK SERVICE
// ==================================================
// Additive module, same init(deps) pattern as callSignaling.js/
// callHosting.js/voice-health.js. Adds two REST endpoints:
//
//   GET /healthz        - fast liveness probe (no auth). Returns 200 while
//                          the process can respond at all; intended for a
//                          process manager / uptime monitor / future load
//                          balancer health check (Tier B item "Load
//                          Balancer Support" reuses this exact route).
//   GET /api/admin/health - fuller snapshot for the admin dashboard
//                          (requireAdmin-gated): CPU load, memory, event
//                          loop lag, socket/room counts, voice quality
//                          summary (from voice-health.js), and a rolling
//                          "degraded" flag history for simple alerting.
//
// Deliberately reuses existing data instead of duplicating it: user/room
// counts come from the same `rooms`/`socketsByUserId` objects server.js
// already maintains, voice quality comes from voice-health.js's
// getGlobalSummary(). This module owns no independent state about rooms
// or users, only its own lightweight sample history + memory-leak guard.
//
// FUTURE-COMPATIBILITY NOTE (Tier B): /healthz has zero dependency on
// in-memory room/user state — it only proves "this process is alive and
// the event loop isn't wedged" — so it's exactly the right shape for a
// future load balancer's health check with no changes needed at
// migration time. /api/admin/health's per-instance numbers (memory,
// event loop lag, this-instance's socket count) stay meaningful in a
// multi-instance world too; the only field that will need widening later
// is "activeRooms"/"onlineUsers" if you want a cluster-wide total instead
// of per-instance — that aggregation belongs in monitor.js (Tier B item
// 9) reading from Redis, not here.

const os = require("os");

const SAMPLE_INTERVAL_MS = 15000;
const MAX_SAMPLES = 240; // 1 hour of history at 15s resolution
// A restart threshold already exists at the process-manager level
// (ecosystem.config.js max_memory_restart: "500M"). This is a *earlier*,
// non-destructive warning so it shows up in logs/dashboard well before
// PM2 would actually kill and restart the process.
const MEMORY_WARN_RSS_MB = 400;
const EVENT_LOOP_LAG_WARN_MS = 200; // sustained lag this high means requests/sockets are queuing

function initHealthCheck({ app, io, requireAdmin, rooms, socketsByUserId, voiceHealth, APP_NAME }) {
    const samples = [];
    let lastLoopCheck = Date.now();
    let lastLagMs = 0;

    // Cheap, dependency-free event-loop-lag probe: schedule a timer for N
    // ms from now, measure how much later it actually fired. A healthy
    // event loop fires within a few ms of schedule; a loop backed up by
    // slow synchronous work (e.g. the old synchronous writeFileSync this
    // codebase already moved away from — see perf/writeQueue.js) shows up
    // here as growing lag, which is the earliest possible signal that
    // something server-side is about to make every connected user's
    // voice/chat feel laggy.
    function scheduleLagProbe() {
        const scheduledAt = Date.now();
        setTimeout(() => {
            lastLagMs = Math.max(0, Date.now() - scheduledAt - 50);
            lastLoopCheck = Date.now();
            scheduleLagProbe();
        }, 50).unref();
    }
    scheduleLagProbe();

    function takeSnapshot() {
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        const loadAvg = os.loadavg(); // [1m, 5m, 15m] — Linux/macOS only, [0,0,0] on Windows
        const voice = voiceHealth ? voiceHealth.getGlobalSummary() : null;

        const snapshot = {
            t: Date.now(),
            uptimeSec: Math.round(process.uptime()),
            memory: { rssMB, heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024), heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024) },
            cpuLoadAvg1m: loadAvg[0],
            eventLoopLagMs: lastLagMs,
            connectedSockets: io.sockets.sockets.size,
            onlineUsers: Object.keys(socketsByUserId).length,
            activeRooms: Object.keys(rooms).length,
            occupiedSeats: Object.values(rooms).reduce((sum, r) => sum + (r.seats || []).filter(Boolean).length, 0),
            voice: voice || { good: 0, fair: 0, poor: 0, activeRooms: 0, trackedConnections: 0 },
            degraded: rssMB > MEMORY_WARN_RSS_MB || lastLagMs > EVENT_LOOP_LAG_WARN_MS
        };
        samples.push(snapshot);
        if (samples.length > MAX_SAMPLES) samples.shift();
        if (snapshot.degraded) {
            console.warn(`[health-check] ⚠️ degraded: rss=${rssMB}MB loopLag=${lastLagMs}ms sockets=${snapshot.connectedSockets} rooms=${snapshot.activeRooms}`);
        }
        return snapshot;
    }

    setInterval(takeSnapshot, SAMPLE_INTERVAL_MS).unref();
    // Populate one sample immediately so /healthz and the dashboard have
    // real numbers from the very first request after boot, not an empty
    // history for the first 15s.
    takeSnapshot();

    // ---- Fast liveness probe: no auth, no heavy work, always cheap. ----
    // Intentionally does NOT report "degraded" as a non-200 — a busy-but-
    // alive process should still be counted "up" by an uptime monitor;
    // "degraded" is a signal for the admin dashboard/alerting, not a
    // reason to pull this instance out of rotation by itself. (Tier B's
    // load balancer can be configured to also watch the degraded flag
    // via /api/admin/health if that's wanted later — a deliberate choice
    // left to that phase, not baked in here.)
    app.get("/healthz", (req, res) => {
        res.status(200).json({ status: "ok", service: APP_NAME || "server", uptimeSec: Math.round(process.uptime()) });
    });

    // ---- Fuller snapshot for the admin dashboard ----
    app.get("/api/admin/health", requireAdmin, (req, res) => {
        const latest = samples[samples.length - 1] || takeSnapshot();
        res.json({ success: true, current: latest, history: samples });
    });

    return { takeSnapshot, getLatest: () => samples[samples.length - 1] || null };
}

module.exports = { initHealthCheck };
