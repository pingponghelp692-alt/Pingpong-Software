// voice-reconnect.js
// ==================================================
// PHASE 1 (Tier A) — SMART AUTO RECONNECT (server-side complement)
// ==================================================
// IMPORTANT — read before extending this file:
// public/app.js ALREADY implements most of "auto reconnect" client-side
// and does it well: per-peer ICE-restart-then-rebuild recovery
// (getOrCreatePeer's oniceconnectionstatechange), infinite Socket.IO
// reconnection with a capped backoff (connectSocket()), automatic
// rejoinRoom() + re-establishing every peer connection on "room-state"
// after reconnect. This module does NOT reimplement any of that — doing
// so would duplicate functionality the spec (and the user) explicitly
// said not to do.
//
// What's actually missing is server-side coordination: right now, when
// user A's socket drops, user B's peer connection just sees ICE go
// disconnected/failed with no context — B's client can't tell "A is
// reconnecting, give it a few seconds" apart from "A is genuinely gone,
// stop trying." That distinction already exists server-side (the 30s
// grace period in server.js's disconnect handler / pendingDisconnects)
// but was never surfaced to the room. This module closes that gap:
//
//   - When a seated user disconnects and enters the grace period,
//     broadcast `voice-peer-reconnecting` to the room so peers' clients
//     can hold their peer connection open (skip the "closePeer" path)
//     instead of tearing it down and rebuilding from scratch the moment
//     the grace period resolves.
//   - When that user reconnects within the grace window, broadcast
//     `voice-peer-resumed` so peers know to actively re-offer instead of
//     waiting passively.
//   - Tracks a bounded per-user reconnect-attempt counter (via the
//     existing "identify" event) so a device stuck in a fast
//     reconnect/fail loop is visible in logs/health-check instead of
//     silently hammering the server.
//
// This is intentionally thin: it emits two new events and keeps one
// small counter map. It does not touch seat assignment, ICE, or any
// existing reconnect timer — server.js's grace-period logic is
// untouched; this module only listens for the same moments and adds a
// broadcast.
//
// FUTURE-COMPATIBILITY NOTE (Tier B): reconnectCounts is a bounded,
// per-instance, ephemeral Map — exactly like voice-health.js's state.
// After the state migration, "is this user in their grace period" will
// be answered by the shared store (Redis) rather than local
// pendingDisconnects, but the broadcast pattern here (emit to the room
// when that shared flag flips) stays the same; only the trigger source
// changes, not this module's public shape.

const MAX_RECONNECT_SAMPLES = 20;
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;
const RAPID_RECONNECT_THRESHOLD = 8; // this many reconnects inside the window is worth a log line

function initVoiceReconnect({ io }) {
    // userId -> array of reconnect timestamps (bounded, rolling)
    const reconnectCounts = new Map();

    function recordReconnect(userId) {
        if (!userId) return;
        const now = Date.now();
        let arr = reconnectCounts.get(userId);
        if (!arr) { arr = []; reconnectCounts.set(userId, arr); }
        arr.push(now);
        while (arr.length > MAX_RECONNECT_SAMPLES) arr.shift();
        const recent = arr.filter((t) => now - t < RECONNECT_WINDOW_MS);
        if (recent.length >= RAPID_RECONNECT_THRESHOLD) {
            console.warn(`[voice-reconnect] ⚠️ rapid reconnect pattern: user=${userId} ${recent.length} reconnects in last ${Math.round(RECONNECT_WINDOW_MS / 1000)}s — likely flaky network or client bug, not a server issue`);
        }
    }

    // Called from server.js at the exact point a seated user's grace
    // period starts (same call site that sets pendingDisconnects[uid]).
    function notifyPeerDisconnecting(roomId, userId) {
        if (!roomId || !userId) return;
        io.to(roomId).emit("voice-peer-reconnecting", { userId });
    }

    // Called from server.js at the exact point a reconnecting user's
    // grace-period entry is cleared because they came back (join-room /
    // rejoin path), so peers know to actively re-offer.
    function notifyPeerResumed(roomId, userId) {
        if (!roomId || !userId) return;
        recordReconnect(userId);
        io.to(roomId).emit("voice-peer-resumed", { userId });
    }

    function getReconnectStats(userId) {
        const arr = reconnectCounts.get(userId) || [];
        const now = Date.now();
        return { recentCount: arr.filter((t) => now - t < RECONNECT_WINDOW_MS).length };
    }

    // Periodic prune so this map can't grow unbounded over a long-running
    // process (same pattern as voice-health.js's cleanup interval).
    setInterval(() => {
        const now = Date.now();
        for (const [userId, arr] of reconnectCounts) {
            const kept = arr.filter((t) => now - t < RECONNECT_WINDOW_MS);
            if (kept.length === 0) reconnectCounts.delete(userId);
            else reconnectCounts.set(userId, kept);
        }
    }, 60 * 1000).unref();

    return { notifyPeerDisconnecting, notifyPeerResumed, getReconnectStats };
}

module.exports = { initVoiceReconnect };
