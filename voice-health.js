// voice-health.js
// ==================================================
// PHASE 1 (Tier A) — VOICE HEALTH MONITOR
// ==================================================
// Additive module, same init(deps) pattern as callSignaling.js/
// callHosting.js. Registers one new socket event ("voice-stats") inside
// the existing io.on("connection") block and exposes read-only query
// functions for the admin dashboard / health-check.js to use — it does
// not touch room membership, seats, or any existing voice-signaling
// event, so there is zero risk of interfering with call setup itself.
//
// WHY CLIENT-REPORTED: real WebRTC connection quality (packet loss,
// jitter, round-trip time) only exists on the RTCPeerConnection objects
// living in each browser/app — this Node process is never in the audio
// path (see callSignaling.js's media-never-touches-this-server note) and
// has no other way to observe it. Clients call the standard
// RTCPeerConnection.getStats() API periodically and report a small
// summary here; nothing about the audio itself is ever sent to or stored
// by the server, only the connection-quality numbers.
//
// TRUST MODEL: a client can only misreport its OWN connection quality
// (worst case: a bad actor lies about their own call being great/awful,
// which affects only their own alerting/analytics, never another user's).
// Every sample is rate-limited and validated before being recorded.
//
// FUTURE-COMPATIBILITY NOTE (state migration / Tier B): all state here
// (`connectionStats`, `roomSummaries`) is a bounded, ephemeral, in-memory
// rolling window — intentionally NOT persisted to JSON/Postgres (quality
// telemetry has no long-term value once a call ends). When the app moves
// to multi-instance, this module's state simply becomes "per-instance,
// for the connections that instance is handling" — nothing here assumes
// or requires global visibility across the whole room, so no redesign is
// needed at migration time. If a truly cluster-wide health view is
// wanted later, aggregate at the Redis/monitor.js layer (Tier B item 9)
// rather than changing how this module collects samples.

const MAX_SAMPLES_PER_CONNECTION = 30; // ~2.5 min of history at the client's 5s report interval
const STATS_RATE_LIMIT_MS = 4000; // client reports every 5s; this just guards against a misbehaving/malicious client sending faster
const ALERT_COOLDOWN_MS = 30000; // don't re-alert on every single sample once a connection is already known-bad

function initVoiceHealth({ io, aiSecurity }) {
    // key: `${roomId}:${userId}:${peerUserId}` -> { samples: [...], lastAlertAt }
    const connectionStats = new Map();
    // key: roomId -> { goodCount, fairCount, poorCount, lastUpdated }
    const roomSummaries = new Map();

    function clampNumber(n, min, max) {
        const v = Number(n);
        if (!Number.isFinite(v)) return min;
        return Math.max(min, Math.min(max, v));
    }

    // Simplified perceptual-quality estimate (0-5 scale, mirrors ITU-T
    // MOS bands) derived from packet loss / jitter / RTT. This is NOT the
    // full ITU-T G.107 E-model (that needs codec-specific Ie/Bpl values
    // we don't have) — it's a deliberately simple, monotonic approximation
    // good enough for alerting and a dashboard color, not for billing or
    // SLA-grade reporting. Documented here so nobody mistakes it for a
    // certified MOS score later.
    function estimateMOS({ packetLossPercent, jitterMs, rttMs }) {
        let score = 4.5; // best case ceiling (matches typical Opus VoIP ceiling, not the theoretical 5.0)
        score -= clampNumber(packetLossPercent, 0, 100) * 0.06; // ~0.06 MOS per 1% loss, roughly matches observed VoIP degradation curves
        score -= clampNumber(jitterMs, 0, 1000) * 0.01;
        score -= Math.max(0, clampNumber(rttMs, 0, 2000) - 150) * 0.004; // RTT under 150ms is basically free
        return Math.max(1, Math.min(4.5, Math.round(score * 10) / 10));
    }

    function levelForMOS(mos) {
        if (mos >= 3.8) return "good";
        if (mos >= 3.0) return "fair";
        return "poor";
    }

    function recomputeRoomSummary(roomId) {
        let good = 0, fair = 0, poor = 0;
        for (const [key, entry] of connectionStats) {
            if (!key.startsWith(`${roomId}:`)) continue;
            const last = entry.samples[entry.samples.length - 1];
            if (!last) continue;
            if (last.level === "good") good++;
            else if (last.level === "fair") fair++;
            else poor++;
        }
        roomSummaries.set(roomId, { goodCount: good, fairCount: fair, poorCount: poor, lastUpdated: Date.now() });
    }

    function registerSocketHandlers(socket) {
        socket.on("voice-stats", (payload) => {
            try {
                if (!socket.userId || !socket.currentRoom) return;
                if (aiSecurity.isRateLimited(`voice-stats:${socket.userId}`, { windowMs: STATS_RATE_LIMIT_MS, max: 1 })) return;
                if (!payload || typeof payload !== "object") return;
                const peerUserId = typeof payload.peerUserId === "string" ? payload.peerUserId.slice(0, 64) : "unknown";

                const packetLossPercent = clampNumber(payload.packetLossPercent, 0, 100);
                const jitterMs = clampNumber(payload.jitterMs, 0, 1000);
                const rttMs = clampNumber(payload.rttMs, 0, 2000);
                const mos = estimateMOS({ packetLossPercent, jitterMs, rttMs });
                const level = levelForMOS(mos);

                const key = `${socket.currentRoom}:${socket.userId}:${peerUserId}`;
                let entry = connectionStats.get(key);
                if (!entry) {
                    entry = { samples: [], lastAlertAt: 0 };
                    connectionStats.set(key, entry);
                }
                entry.samples.push({ t: Date.now(), packetLossPercent, jitterMs, rttMs, mos, level });
                if (entry.samples.length > MAX_SAMPLES_PER_CONNECTION) entry.samples.shift();

                recomputeRoomSummary(socket.currentRoom);

                if (level === "poor" && Date.now() - entry.lastAlertAt > ALERT_COOLDOWN_MS) {
                    entry.lastAlertAt = Date.now();
                    console.warn(`[voice-health] ⚠️ Poor quality: room=${socket.currentRoom} user=${socket.userId} peer=${peerUserId} mos=${mos} loss=${packetLossPercent}% jitter=${jitterMs}ms rtt=${rttMs}ms`);
                    // Self-only notification (never broadcast another user's
                    // connection quality to the room) — lets the client show
                    // a "poor connection" indicator / suggest a rejoin.
                    socket.emit("voice-quality-alert", { peerUserId, mos, level, packetLossPercent, jitterMs, rttMs });
                }
            } catch (e) {
                console.error("[voice-health] voice-stats handler error:", e && e.message);
            }
        });
    }

    // Drop stats for connections whose room no longer has an active
    // socket reporting (call ended / room left) so this map can't grow
    // unbounded across a long-running process.
    setInterval(() => {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [key, entry] of connectionStats) {
            const last = entry.samples[entry.samples.length - 1];
            if (!last || last.t < cutoff) connectionStats.delete(key);
        }
        for (const [roomId] of roomSummaries) recomputeRoomSummary(roomId);
    }, 60 * 1000).unref();

    // ---- Read-only queries for health-check.js / admin dashboard ----
    function getRoomHealth(roomId) {
        return roomSummaries.get(roomId) || { goodCount: 0, fairCount: 0, poorCount: 0, lastUpdated: null };
    }
    function getGlobalSummary() {
        let good = 0, fair = 0, poor = 0;
        for (const s of roomSummaries.values()) { good += s.goodCount; fair += s.fairCount; poor += s.poorCount; }
        return { good, fair, poor, activeRooms: roomSummaries.size, trackedConnections: connectionStats.size };
    }

    return { registerSocketHandlers, getRoomHealth, getGlobalSummary };
}

module.exports = { initVoiceHealth };
