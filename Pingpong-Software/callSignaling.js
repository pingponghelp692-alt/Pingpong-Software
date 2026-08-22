// callSignaling.js
// ==================================================
// PRIVATE INBOX AUDIO/VIDEO CALLING — signaling only
// ==================================================
// Purely additive, same pattern as banManagement.js/analyticsHub.js: one
// init function that wires a couple of REST routes off the existing `app`,
// plus two functions server.js calls from inside its single
// io.on("connection", ...) block (registerSocketHandlers) and its existing
// disconnect handler (handleDisconnect) — no separate io.on("connection")
// is created, so this never competes with or duplicates the app's existing
// connection registration.
//
// Media never touches this server: WebRTC is peer-to-peer between the two
// phones (audio/video/DTLS-SRTP encrypted end-to-end). This module's only
// job is (a) call lifecycle — invite/ring/accept/reject/busy/end — and
// (b) relaying opaque SDP offers/answers and ICE candidates between the
// two participants' sockets so their browsers can find each other. It never
// reads, stores, or has access to the actual audio/video stream.
//
// Security model: every event trusts socket.userId (set by the existing
// identify/join-room handlers off the authenticated session), never a
// userId the client claims in the payload. A call's signaling is only ever
// relayed to the two socket ids recorded on that call at invite time, so a
// third party — even one who guesses a callId — cannot join, listen in on
// signaling for, or otherwise touch someone else's call.

const path = require("path");
const crypto = require("crypto");
// TURN/STUN config (Phase 1 Tier A, see turn-config.js) — see the ICE
// server route below for why this replaced the inline buildIceServers()
// that used to live in this file.
const { getIceServersAsync } = require("./turn-config.js");

const RING_TIMEOUT_MS = 45000; // "missed call" if not answered in time

// ROOT-CAUSE FIX (voice stability pass): a call used to be torn down the
// instant either participant's socket disconnected — a page refresh, an app
// backgrounding briefly, or a few seconds of dead mobile signal all ended
// the call immediately with no chance to recover, even though the room-seat
// system elsewhere in this project already gives exactly this kind of blip
// a 30s grace window. This mirrors that same pattern for calls: a
// disconnect starts a short grace timer instead of ending the call outright,
// and if the same user's next socket shows up (via identify/join-room)
// before it expires, the call is silently re-pointed at the new socket and
// carries on — no re-dial required.
const DISCONNECT_GRACE_MS = 15000;

function initCallSignaling({ app, io, DATA_FOLDER, safeRead, safeWrite, findUserByUserId, users, socketsByUserId, callSocketsByUserId, sanitizeText, isRateLimited, userAuth }) {
    // Fail closed if this module is ever initialized without the auth
    // dependency. Production server.js always injects userAuth; the explicit
    // 503 fallback prevents a miswired deployment from exposing TURN
    // credentials or private call history.
    const requireUserAuth = userAuth && typeof userAuth.requireUserAuth === "function"
        ? userAuth.requireUserAuth
        : (req, res) => res.status(503).json({ success: false, message: "Authentication service unavailable" });

    const HISTORY_FILE = path.join(DATA_FOLDER, "callHistory.json");
    const callHistory = safeRead(HISTORY_FILE, {}); // conversationKey -> [entries]
    function saveHistory() { safeWrite(HISTORY_FILE, callHistory); }
    function conversationKey(a, b) { return [a, b].sort().join("_"); }

    const activeCalls = new Map();   // callId -> call record
    const userCallState = new Map(); // userId -> callId (busy tracking)

    function publicUser(userId) {
        const found = findUserByUserId(userId);
        return found ? { userId, userName: found.user.name, userPhoto: found.user.photo || "" } : { userId, userName: "User", userPhoto: "" };
    }

    function socketFor(userId) {
        const sid = socketsByUserId[userId];
        return sid ? io.sockets.sockets.get(sid) : null;
    }

    // GAP #1 (Redis Authoritative Runtime State) — cross-instance-safe
    // notify for a specific user, for the call-lifecycle events below that
    // only need "reach this user eventually" (ended/busy/accepted/
    // rejected/connected/peer-reconnecting/peer-resumed), NOT the precise
    // single-answering-device SDP/ICE relay (that stays exactly as-is —
    // see the module header's note on why a single recorded socket per
    // side is intentional there). Local socketsByUserId is the synchronous
    // fast path (unchanged, zero added latency for the common
    // single-instance case). Only a genuine local MISS falls back to an
    // async Redis lookup (the existing userState.js mirror, Phase 2A) —
    // fire-and-forget, matching every other redis/* fallback in this
    // codebase, so a caller never needs to await it. `io.to(socketId)`
    // (as opposed to `io.sockets.sockets.get(socketId)`) is what makes the
    // remote-instance case actually deliver: Socket.IO's Redis Adapter
    // (already wired in server.js) routes an emit addressed to a specific
    // socket id across the whole cluster, not just this process — this
    // module just never had a remote socket id to address until now.
    function emitToUserSocket(userId, event, payload) {
        const sid = socketsByUserId[userId];
        if (sid) { io.to(sid).emit(event, payload); return; }
        try {
            const userState = require("./redis/userState.js");
            userState.getUserState(userId).then((state) => {
                if (state && state.socketId) io.to(state.socketId).emit(event, payload);
            }).catch(() => {});
        } catch (e) { /* redis/userState.js unavailable — best-effort only */ }
    }

    // VOICE FIX (multi-device): everything else in this module still routes
    // an in-progress call through a single recorded socket per side (that's
    // correct — a call should only ever ring/connect on the one device that
    // answered it). This is only for the initial "who do we ring" moment:
    // if a user is logged in on more than one device, every device should
    // see the incoming call, not just whichever one happens to be
    // "primary" in socketsByUserId.
    function allSocketsFor(userId) {
        const set = callSocketsByUserId && callSocketsByUserId.get(userId);
        const ids = set && set.size ? Array.from(set) : (socketsByUserId[userId] ? [socketsByUserId[userId]] : []);
        return ids.map((sid) => io.sockets.sockets.get(sid)).filter(Boolean);
    }

    function logHistory(call, status) {
        const key = conversationKey(call.callerId, call.calleeId);
        if (!callHistory[key]) callHistory[key] = [];
        const durationSec = call.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
        callHistory[key].push({
            callId: call.callId,
            from: call.callerId,
            to: call.calleeId,
            type: call.type,
            status, // "completed" | "missed" | "rejected" | "cancelled"
            startedAt: call.startedAt,
            connectedAt: call.connectedAt || null,
            endedAt: Date.now(),
            durationSec
        });
        // Cap history growth per conversation so this file doesn't grow forever.
        if (callHistory[key].length > 300) callHistory[key] = callHistory[key].slice(-300);
        saveHistory();
        return callHistory[key][callHistory[key].length - 1];
    }

    function clearCall(callId) {
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.ringTimer) clearTimeout(call.ringTimer);
        if (call.disconnectGrace) clearTimeout(call.disconnectGrace.timer);
        userCallState.delete(call.callerId);
        userCallState.delete(call.calleeId);
        activeCalls.delete(callId);
    }

    function endCall(callId, endedBy, reason) {
        const call = activeCalls.get(callId);
        if (!call) return;
        const status = call.status === "connected" ? "completed" : (reason || "cancelled");
        const entry = logHistory(call, status);
        const otherId = endedBy === call.callerId ? call.calleeId : call.callerId;
        // GAP #1 — cross-instance-safe via emitToUserSocket()
        emitToUserSocket(otherId, "call:ended", { callId, endedBy, reason: status, historyEntry: entry });
        emitToUserSocket(endedBy, "call:ended", { callId, endedBy, reason: status, historyEntry: entry, self: true });
        clearCall(callId);
    }

    // ---------------- REST ----------------
    // ICE server config comes from env so an operator can plug in their own
    // TURN server (required for calls to succeed across most real-world
    // mobile carrier NATs) without touching code. Falls back to a public
    // STUN-only server, which is enough for many but not all networks.
    //
    // INTEGRATION NOTE (post Phase-1/2A audit): this route used to build
    // its own ICE server list inline (a near-duplicate of turn-config.js's
    // static-credential path). That inline copy has been removed in favor
    // of turn-config.js's getIceServers(), which is a strict superset:
    // same env vars (STUN_URL/TURN_URL/TURN_USERNAME/TURN_CREDENTIAL),
    // same validation rules, same fallback-to-STUN-only behavior, same
    // {success, iceServers} response shape — so any deployment using
    // static TURN credentials today keeps working with zero config
    // changes. It additionally supports comma-separated multi-URL TURN_URL
    // and, whenever TURN_SECRET+TURN_REALM are set, short-lived per-user
    // HMAC TURN credentials instead of one static pair shared by every
    // user forever (see turn-config.js's header for why that matters).
    // getIceServers() is intentionally called per-request, not cached at
    // startup: dynamic credentials expire (TURN_CREDENTIAL_TTL_SECONDS,
    // default 6h) and must be freshly minted per call; static-mode
    // deployments pay a trivial re-validation cost per request in
    // exchange for that correctness — env vars aren't reread from disk
    // mid-process either way, so behavior doesn't change, only timing.
    function usersafeUserId(req) {
        const mobile = req.authedMobile;
        const user = mobile && users && users[mobile];
        return user && user.userId ? user.userId : "";
    }

    // PHASE 7 (2026-08-17): getIceServersAsync() prefers Cloudflare TURN
    // (short-lived credentials) when CLOUDFLARE_TURN_KEY_ID/
    // CLOUDFLARE_TURN_API_TOKEN are configured, and transparently falls
    // back to the exact getIceServers() behavior described above
    // otherwise — same {success, iceServers} response shape either way,
    // so no client-side change was needed for this route.
    app.get("/api/calls/ice-servers", requireUserAuth, async (req, res) => {
        const found = findUserByUserId(usersafeUserId(req));
        const userId = found ? found.user.userId : undefined;
        const result = await getIceServersAsync(userId);
        res.json(result);
    });

    app.get("/api/calls/history/:userId1/:userId2", requireUserAuth, (req, res) => {
        const actor = usersafeUserId(req);
        if (actor !== req.params.userId1 && actor !== req.params.userId2) {
            return res.status(403).json({ success: false, message: "You can only view your own call history" });
        }
        const key = conversationKey(req.params.userId1, req.params.userId2);
        res.json({ success: true, history: callHistory[key] || [] });
    });

    // ---------------- Socket handlers ----------------
    // Called once per connected socket from server.js's existing
    // io.on("connection", socket => { ... }) block.
    function registerSocketHandlers(socket) {
        // Wraps every handler below so a malformed payload (missing field,
        // wrong type, client sending garbage) can never throw uncaught out
        // of a socket event and take the whole server down with it.
        function safeHandler(fn) {
            return (payload) => {
                try { fn(payload || {}); }
                catch (e) { console.error("[callSignaling] handler error:", e && e.message); }
            };
        }

        socket.on("call:invite", safeHandler(({ toUserId, callType }) => {
            const fromUserId = socket.userId;
            if (!fromUserId || !toUserId || fromUserId === toUserId) return;
            if (callType !== "audio" && callType !== "video") return;
            if (isRateLimited(`call-invite:${fromUserId}`, { windowMs: 15000, max: 6 })) return;
            const toFound = findUserByUserId(toUserId);
            if (!toFound || toFound.user.banned) return;

            if (userCallState.has(fromUserId)) { socket.emit("call:busy", { toUserId, self: true }); return; }
            // VOICE FIX (multi-device): ring every device the callee is
            // currently connected on (phone + tablet + a second browser tab,
            // etc.), not just whichever socket happens to be "primary".
            // Whichever one accepts first wins; the rest get told to stop
            // ringing below.
            const targetSockets = allSocketsFor(toUserId);
            if (!targetSockets.length) { socket.emit("call:offline", { toUserId }); return; }
            if (userCallState.has(toUserId)) { socket.emit("call:busy", { toUserId }); return; }

            const callId = crypto.randomUUID();
            const call = {
                callId, callerId: fromUserId, calleeId: toUserId, type: callType,
                status: "ringing", startedAt: Date.now(), connectedAt: null,
                callerSocketId: socket.id, calleeSocketId: null, // locked in on accept, once we know which device answered
                ringingSocketIds: targetSockets.map((s) => s.id)
            };
            call.ringTimer = setTimeout(() => {
                const c = activeCalls.get(callId);
                if (!c || c.status !== "ringing") return;
                logHistory(c, "missed");
                emitToUserSocket(c.callerId, "call:ended", { callId, reason: "no-answer" }); // GAP #1 — cross-instance-safe
                (c.ringingSocketIds || []).forEach((sid) => {
                    const s = io.sockets.sockets.get(sid);
                    if (s) s.emit("call:ended", { callId, reason: "no-answer" });
                });
                clearCall(callId);
            }, RING_TIMEOUT_MS);
            activeCalls.set(callId, call);
            userCallState.set(fromUserId, callId);
            userCallState.set(toUserId, callId);

            console.log(`📞 [call ${callId}] invite: ${fromUserId} -> ${toUserId} (${callType}) ringing ${targetSockets.length} device(s), caller socket ${socket.id}`);
            targetSockets.forEach((s) => s.emit("call:incoming", { callId, callType, from: publicUser(fromUserId) }));
            socket.emit("call:ringing", { callId, toUserId });
        }));

        socket.on("call:accept", safeHandler(({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || call.calleeId !== socket.userId || call.status !== "ringing") return;
            call.status = "connecting";
            call.calleeSocketId = socket.id;
            // Tell every OTHER device that was ringing for this call to stop
            // — one device answered, so the rest should dismiss their
            // incoming-call screen rather than staying stuck ringing.
            (call.ringingSocketIds || []).forEach((sid) => {
                if (sid === socket.id) return;
                const s = io.sockets.sockets.get(sid);
                if (s) s.emit("call:incoming-cancel", { callId });
            });
            if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; }
            console.log(`📞 [call ${callId}] accepted by ${socket.userId}`);
            emitToUserSocket(call.callerId, "call:accepted", { callId }); // GAP #1 — cross-instance-safe
        }));

        socket.on("call:reject", safeHandler(({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || call.calleeId !== socket.userId || call.status !== "ringing") return;
            const entry = logHistory(call, "rejected");
            console.log(`📞 [call ${callId}] rejected by ${socket.userId}`);
            emitToUserSocket(call.callerId, "call:ended", { callId, reason: "rejected", historyEntry: entry }); // GAP #1 — cross-instance-safe
            (call.ringingSocketIds || []).forEach((sid) => {
                if (sid === socket.id) return;
                const s = io.sockets.sockets.get(sid);
                if (s) s.emit("call:incoming-cancel", { callId });
            });
            clearCall(callId);
        }));

        socket.on("call:cancel", safeHandler(({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || call.callerId !== socket.userId || call.status !== "ringing") return;
            const entry = logHistory(call, "cancelled");
            console.log(`📞 [call ${callId}] cancelled by ${socket.userId}`);
            (call.ringingSocketIds || []).forEach((sid) => {
                const s = io.sockets.sockets.get(sid);
                if (s) s.emit("call:ended", { callId, reason: "cancelled", historyEntry: entry });
            });
            clearCall(callId);
        }));

        socket.on("call:end", safeHandler(({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || (call.callerId !== socket.userId && call.calleeId !== socket.userId)) return;
            console.log(`📞 [call ${callId}] ended by ${socket.userId}`);
            endCall(callId, socket.userId, "ended");
        }));

        // ----- WebRTC signaling relay (opaque payloads; never inspected) -----
        function relayTo(call, fromUserId, event, payload) {
            const otherSocketId = fromUserId === call.callerId ? call.calleeSocketId : call.callerSocketId;
            if (!otherSocketId) return;
            // io.to(socketId) is Redis-adapter aware and works when the two
            // call participants are connected to different Node instances.
            // socketFor() only inspected this process, which could leave a
            // call ringing/accepted while SDP and ICE never reached the peer.
            io.to(otherSocketId).emit(event, payload);
        }
        function validParticipant(call, userId) {
            return call && (call.callerId === userId || call.calleeId === userId);
        }

        // A stale/duplicate socket for the same userId (old tab, superseded
        // connection) should never be able to inject signaling into someone
        // else's live call — only the exact socket recorded on the call for
        // that side is trusted, same principle as handleDisconnect() above.
        function isLiveCallSocket(call, userId, sock) {
            const expected = userId === call.callerId ? call.callerSocketId : call.calleeSocketId;
            return !expected || expected === sock.id;
        }

        socket.on("call:offer", safeHandler(({ callId, sdp }) => {
            if (isRateLimited(`call-sig:${socket.userId}`, { windowMs: 10000, max: 40 })) return;
            const call = activeCalls.get(callId);
            if (!validParticipant(call, socket.userId) || socket.userId !== call.callerId) return;
            if (!isLiveCallSocket(call, socket.userId, socket) || !sdp) return;
            relayTo(call, socket.userId, "call:offer", { callId, sdp });
        }));
        socket.on("call:answer", safeHandler(({ callId, sdp }) => {
            if (isRateLimited(`call-sig:${socket.userId}`, { windowMs: 10000, max: 40 })) return;
            const call = activeCalls.get(callId);
            if (!validParticipant(call, socket.userId) || socket.userId !== call.calleeId) return;
            if (!isLiveCallSocket(call, socket.userId, socket) || !sdp) return;
            call.status = "connected";
            call.connectedAt = Date.now();
            relayTo(call, socket.userId, "call:answer", { callId, sdp });
            // GAP #1 — cross-instance-safe via emitToUserSocket()
            emitToUserSocket(call.callerId, "call:connected", { callId });
            emitToUserSocket(call.calleeId, "call:connected", { callId });
        }));
        socket.on("call:ice-candidate", safeHandler(({ callId, candidate }) => {
            if (isRateLimited(`call-sig:${socket.userId}`, { windowMs: 10000, max: 120 })) return;
            const call = activeCalls.get(callId);
            // Shape-validate before relaying: this is still an opaque
            // payload as far as its *contents* go (never inspected), but a
            // malformed object (missing/non-string candidate field, e.g. a
            // buggy or malicious client) should never be forwarded on to
            // the other participant's browser to choke on.
            if (!validParticipant(call, socket.userId) || !candidate || typeof candidate.candidate !== "string") return;
            if (!isLiveCallSocket(call, socket.userId, socket)) return;
            relayTo(call, socket.userId, "call:ice-candidate", { callId, candidate });
        }));
        socket.on("call:media-state", safeHandler(({ callId, micMuted, cameraOff }) => {
            if (isRateLimited(`call-sig:${socket.userId}`, { windowMs: 10000, max: 40 })) return;
            const call = activeCalls.get(callId);
            if (!validParticipant(call, socket.userId)) return;
            if (!isLiveCallSocket(call, socket.userId, socket)) return;
            relayTo(call, socket.userId, "call:peer-media-state", { callId, micMuted: !!micMuted, cameraOff: !!cameraOff });
        }));
    }

    // Called from server.js's existing socket.on("disconnect", ...) handler.
    // `socketId` is the id of the socket that just disconnected — used to
    // ignore a stale disconnect event for a socket that a faster reconnect
    // has already superseded (same tie-breaker pattern as the room-seat
    // grace period in server.js).
    function handleDisconnect(userId, socketId) {
        if (!userId) return;
        const callId = userCallState.get(userId);
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (!call) return;

        // Still ringing (pre-accept): a single device dropping is not
        // fatal to the call as long as other devices are still ringing, or
        // it isn't the caller. Handled separately from the
        // connected/connecting grace-period logic below, which only
        // applies once a specific device is actually locked in on the call.
        if (call.status === "ringing") {
            if (userId === call.callerId) {
                console.log(`📞 [call ${callId}] caller ${userId} disconnected while ringing — cancelling`);
                (call.ringingSocketIds || []).forEach((sid) => {
                    const s = io.sockets.sockets.get(sid);
                    if (s) s.emit("call:ended", { callId, reason: "cancelled" });
                });
                clearCall(callId);
                return;
            }
            // Callee side: drop just this one device from the ring list.
            call.ringingSocketIds = (call.ringingSocketIds || []).filter((sid) => sid !== socketId);
            if (call.ringingSocketIds.length > 0) return; // other devices are still ringing, nothing to do
            console.log(`📞 [call ${callId}] last ringing device for ${userId} disconnected — ending as no-answer`);
            if (call.ringTimer) clearTimeout(call.ringTimer);
            logHistory(call, "missed");
            emitToUserSocket(call.callerId, "call:ended", { callId, reason: "no-answer" }); // GAP #1 — cross-instance-safe
            clearCall(callId);
            return;
        }

        const mySocketId = userId === call.callerId ? call.callerSocketId : call.calleeSocketId;
        if (socketId && mySocketId && socketId !== mySocketId) {
            // This disconnect belongs to an old socket that's no longer the
            // one attached to the call (e.g. a duplicate tab) — ignore it.
            return;
        }
        if (call.disconnectGrace) return; // already counting down for this call
        const otherId = userId === call.callerId ? call.calleeId : call.callerId;
        console.log(`📞 [call ${callId}] socket disconnected for ${userId} — starting ${DISCONNECT_GRACE_MS}ms reconnect grace period`);
        emitToUserSocket(otherId, "call:peer-reconnecting", { callId }); // GAP #1 — cross-instance-safe
        call.disconnectGrace = {
            userId,
            timer: setTimeout(() => {
                const c = activeCalls.get(callId);
                if (!c) return;
                console.log(`📞 [call ${callId}] reconnect grace period expired for ${userId} — ending call`);
                const status = c.status === "connected" ? "completed" : "missed";
                const entry = logHistory(c, status);
                emitToUserSocket(otherId, "call:ended", { callId, reason: "peer-disconnected", historyEntry: entry }); // GAP #1 — cross-instance-safe
                clearCall(callId);
            }, DISCONNECT_GRACE_MS)
        };
    }

    // Called from server.js's existing "identify" and "join-room" handlers,
    // right after they update socketsByUserId[userId] for a (re)connecting
    // socket. If that user has a call mid-grace-period, cancel the pending
    // end-call timer and re-point the call at the new socket instead of
    // treating it as a fresh, unrelated connection.
    function resumeCall(userId, newSocketId) {
        if (!userId || !newSocketId) return;
        const callId = userCallState.get(userId);
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (!call || !call.disconnectGrace || call.disconnectGrace.userId !== userId) return;
        clearTimeout(call.disconnectGrace.timer);
        call.disconnectGrace = null;
        if (call.callerId === userId) call.callerSocketId = newSocketId;
        else call.calleeSocketId = newSocketId;
        const otherId = userId === call.callerId ? call.calleeId : call.callerId;
        console.log(`📞 [call ${callId}] ${userId} reconnected within grace period — resuming call`);
        // GAP #1 — cross-instance-safe via emitToUserSocket()
        emitToUserSocket(otherId, "call:peer-resumed", { callId });
        emitToUserSocket(userId, "call:peer-resumed", { callId, self: true });
    }

    return { registerSocketHandlers, handleDisconnect, resumeCall };
}

module.exports = { initCallSignaling };
