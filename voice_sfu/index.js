// voice_sfu/index.js
// ==================================================
// PHASE 3, STEP 3.2 — SFU MODULE ENTRY POINT (ADDITIVE)
// ==================================================
// Same init(deps) pattern as every other feature module in this
// codebase (callSignaling.js, callHosting.js, voice-health.js,
// room-recovery.js). Registers ONLY new routes under /api/voice-sfu and
// /api/admin/voice-sfu — no existing route, socket event, or module is
// modified or removed by this file.
//
// BACKWARD COMPATIBILITY (spec requirement #8): VOICE_MODE defaults to
// "mesh" (see provider.js's currentVoiceMode()). Nothing in
// public/app.js, server.js's existing voice-offer/voice-answer/
// voice-candidate handling, or callSignaling.js/callHosting.js calls
// into this module today, so a deployment that never sets VOICE_MODE or
// never installs livekit-server-sdk behaves EXACTLY as before this
// file existed. The new /api/voice-sfu/* routes exist but are inert
// until a client is built to call them (Step 3.3) and VOICE_MODE=sfu is
// set with real LiveKit credentials.
//
// WHY isRateLimited AND requireAdmin/requirePermission ARE REUSED HERE:
// same instances server.js already created and passes to
// callSignaling.js/callHosting.js — no second rate-limiter, no second
// admin-auth implementation, per spec requirement "No duplicate
// implementations."

const { initSfuRoomManager } = require("./roomManager.js");
const livekit = require("./livekit.js");
const { getActiveProvider, currentVoiceMode } = require("./provider.js");
const { isConfigured: sfuConfigured } = require("./token.js");
const { initSfuHealth } = require("./health.js");
const { initVoiceSfuSync } = require("./sync.js");
const rollout = require("./rollout.js");
const { runStartupCheck } = require("./startupCheck.js");

function initVoiceSfu({ app, rooms, isRateLimited, requireAdmin, requirePermission, voiceHealth }) {
    const roomManager = initSfuRoomManager({ rooms });
    const sfuHealth = initSfuHealth({ voiceHealth, roomManager });
    // PHASE 3, STEP 3.4 — room/participant/seat lifecycle synchronization
    // (see sync.js's own header). server.js calls the returned `sync`
    // object's hooks from its existing room-create/room-close/leave-room/
    // grace-period/seat-change call sites; nothing here is called
    // automatically by anything in this file.
    const sync = initVoiceSfuSync({ roomManager, livekit, sfuHealth });

    function provider() {
        return getActiveProvider({ roomManager, livekit });
    }

    // PHASE 3, STEP 3.5 — startup readiness check. Runs once at init,
    // logs to console (never throws — a misconfigured SFU setup must
    // never take down the whole app, same fail-safe posture as every
    // other voice_sfu module), and the result is cached for the new
    // /api/admin/voice-sfu/readiness route below so an operator can
    // re-check it without restarting the process.
    const startupReadiness = runStartupCheck();

    // ---------------- REST: client-facing ----------------

    // Lets a client decide whether to use its mesh path (existing,
    // untouched) or attempt an SFU connection, without hardcoding
    // VOICE_MODE client-side. Public/no-auth, mirrors
    // /api/calls/ice-servers's trust level (returns only non-sensitive
    // config, never a token).
    app.get("/api/voice-sfu/mode", (req, res) => {
        // PHASE 3, STEP 3.5: existing response shape/values are UNCHANGED
        // when no ?roomId= is given — voiceMode still reports plain
        // "mesh"/"sfu" exactly as before (currentVoiceMode() is untouched,
        // see provider.js), so the Step 3.3 client (which never sends
        // roomId here) sees byte-identical responses. If a caller DOES
        // pass ?roomId= (opt-in, no client change required to keep
        // working), an additional effectiveVoiceMode field reports what
        // THAT room actually resolves to under a staged rollout.
        const body = { success: true, voiceMode: currentVoiceMode(), sfuConfigured: sfuConfigured() };
        const roomId = req.query && req.query.roomId;
        if (roomId) {
            const { effectiveVoiceModeForRoom } = require("./provider.js");
            body.effectiveVoiceMode = effectiveVoiceModeForRoom({ roomId, roomManager });
        }
        res.json(body);
    });

    // Body: { roomId, userId, userName }. Same trust level as the
    // existing /api/calls/ice-servers route (plain userId, no separate
    // token check) — this app's REST layer already relies on the
    // Socket.IO connection having done the real join-room/seat
    // authorization; this route only ADDS the seat check
    // (roomManager.isUserSeatedInRoom) so a stale/wrong userId can't
    // mint a token for a room the caller never actually joined.
    app.post("/api/voice-sfu/join", async (req, res) => {
        try {
            const { roomId, userId, userName } = req.body || {};
            if (!roomId || !userId) return res.status(400).json({ success: false, message: "roomId and userId are required" });
            if (isRateLimited(`voice-sfu-join:${userId}`, { windowMs: 3000, max: 1 })) {
                return res.status(429).json({ success: false, message: "Too many requests" });
            }
            // PHASE 3, STEP 3.5: was provider() (global VOICE_MODE only).
            // getActiveProviderForRoom resolves the SAME way for plain
            // mesh/sfu deployments (no behavior change there) and adds
            // correct per-room staged-rollout resolution — see rollout.js.
            // This is the one call site that actually decides which
            // transport a given join gets, so it's the one that must be
            // room-aware for staged rollout to mean anything.
            const { getActiveProviderForRoom } = require("./provider.js");
            // PHASE 3, STEP 3.6 — spec item 4 (token latency, join
            // latency). joinStartedAt covers the WHOLE /join request
            // (route entry to response); tokenStartedAt covers only
            // getConnectionInfo() (token mint + ensureRoom, mode==="sfu"
            // only — mesh mode's getConnectionInfo() is a cheap sync-ish
            // call and isn't a metric anyone asked for here). Both are
            // additive telemetry only — never gate or slow the response.
            const joinStartedAt = Date.now();
            const info = await getActiveProviderForRoom({ roomId, roomManager, livekit }).getConnectionInfo({ roomId, userId, userName });
            if (info.mode === "sfu") sfuHealth.recordTokenLatency(Date.now() - joinStartedAt);
            if (info.mode === "sfu") {
                roomManager.recordJoin(info.roomName);
                // PHASE 3, STEP 3.6 — info.canPublish reflects whether THIS
                // token was minted seated (true) or as an audience listener
                // (false, see provider.js). Kept in sync on every later
                // seat change too, via sync.js's onSeatChanged — this call
                // only ever needs to set the STARTING value.
                roomManager.setPublisherStatus(info.roomName, userId, !!info.canPublish);
                sfuHealth.recordJoin({ roomId, userId });
                sfuHealth.recordJoinLatency(Date.now() - joinStartedAt); // full request time, only meaningful once we know it was really an SFU join
            }
            res.json({ success: true, ...info });
        } catch (e) {
            // PHASE 3, STEP 3.6: NOT_SEATED can no longer actually be
            // thrown by provider.js (audience now gets a token too) — kept
            // in this status mapping defensively, alongside the new
            // NOT_IN_ROOM (thrown when the caller isn't a member of the
            // PingPong room at all), so neither is ever silently treated
            // as a 500.
            const status = e && (e.code === "NOT_SEATED" || e.code === "NOT_IN_ROOM") ? 403 : e && e.code === "LIVEKIT_NOT_CONFIGURED" ? 503 : 500;
            if (status === 500) console.error("[voice_sfu] /join error:", e && e.message);
            // PHASE 3, STEP 3.4: a 403 (NOT_SEATED) is a normal authorization
            // rejection, not a token/LiveKit failure — only count 503/500
            // (LiveKit unconfigured, SDK missing, or an actual mint/ensureRoom
            // error) toward health.js's dedicated tokenFailureCount so that
            // metric reflects real infra/config problems, not routine
            // not-seated-yet requests.
            if (status !== 403) {
                sfuHealth.recordTokenFailure({ roomId: req.body && req.body.roomId, userId: req.body && req.body.userId, message: e && e.message });
            } else {
                sfuHealth.recordError({ roomId: req.body && req.body.roomId, userId: req.body && req.body.userId, message: e && e.message });
            }
            res.status(status).json({ success: false, message: (e && e.message) || "Failed to join SFU room" });
        }
    });

    // Best-effort bookkeeping only (see roomManager.js header) — does
    // NOT force-remove the participant from LiveKit; a client simply
    // stops publishing/subscribing on its own disconnect, same as the
    // mesh path already lets happen. Admin-forced removal is the
    // separate /api/admin/voice-sfu/kick route below.
    app.post("/api/voice-sfu/leave", (req, res) => {
        try {
            const { roomId, userId } = req.body || {};
            if (!roomId || !userId) return res.status(400).json({ success: false, message: "roomId and userId are required" });
            // PHASE 3, STEP 3.5: was a global currentVoiceMode() check —
            // now per-room, same reasoning as the /join route above.
            const { effectiveVoiceModeForRoom } = require("./provider.js");
            if (effectiveVoiceModeForRoom({ roomId, roomManager }) === "sfu") {
                const liveKitRoomName = roomManager.toLiveKitRoomName(roomId);
                roomManager.recordLeave(liveKitRoomName);
                roomManager.setPublisherStatus(liveKitRoomName, userId, false); // PHASE 3, STEP 3.6 — clears publisher bookkeeping regardless of whether this identity was seated or audience at leave time
                sfuHealth.recordLeave({ roomId, userId });
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: "Failed to record leave" });
        }
    });

    // ---------------- REST: admin ----------------

    app.get("/api/admin/voice-sfu/health", requireAdmin, requirePermission("voice-sfu:manage"), (req, res) => {
        res.json({ success: true, health: sfuHealth.getCombinedHealth() });
    });

    // PHASE 3, STEP 3.5 (new route) — production readiness snapshot: the
    // startup check's findings (cached from init, re-runs the cheap
    // env/config checks fresh on every call so a mid-session env change
    // via a process manager reload is reflected) plus the current
    // rollout config, so an operator can verify "is it safe to move to
    // the next stage" from the admin panel without reading server logs.
    app.get("/api/admin/voice-sfu/readiness", requireAdmin, requirePermission("voice-sfu:manage"), (req, res) => {
        const fresh = runStartupCheck({ quiet: true });
        res.json({ success: true, readiness: fresh, cachedAtBoot: startupReadiness });
    });

    // Emergency/moderation hook: force-disconnect one participant from
    // the LiveKit room without touching PingPong's own seat/room state
    // (an admin using this would typically pair it with the EXISTING
    // rooms:kick-user seat-clear action for the mesh-equivalent effect;
    // this route only handles the SFU media-connection side).
    app.post("/api/admin/voice-sfu/kick", requireAdmin, requirePermission("voice-sfu:manage"), async (req, res) => {
        try {
            const { roomId, userId } = req.body || {};
            if (!roomId || !userId) return res.status(400).json({ success: false, message: "roomId and userId are required" });
            if (!sfuConfigured()) return res.status(503).json({ success: false, message: "LiveKit is not configured" });
            const liveKitRoomName = roomManager.toLiveKitRoomName(roomId);
            await livekit.removeParticipant(liveKitRoomName, userId);
            roomManager.recordLeave(liveKitRoomName);
            sfuHealth.recordLeave({ roomId, userId });
            res.json({ success: true });
        } catch (e) {
            console.error("[voice_sfu] /admin/kick error:", e && e.message);
            res.status(500).json({ success: false, message: "Failed to remove participant" });
        }
    });

    // startupReadiness exposed for anything server.js wants to log/check
    // at boot beyond the console output runStartupCheck() already printed
    // (e.g. a future health-check.js integration) — additive, optional.
    return { provider, roomManager, sfuHealth, sync, startupReadiness };
}

module.exports = { initVoiceSfu };
