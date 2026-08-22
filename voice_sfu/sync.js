// voice_sfu/sync.js
// ==================================================
// PHASE 3, STEP 3.4 — SERVER <-> LIVEKIT ROOM/PARTICIPANT LIFECYCLE SYNC
// ==================================================
// Continues from Step 3.2 (voice_sfu/provider.js, roomManager.js,
// livekit.js, token.js, health.js) and Step 3.3 (public/voice-sfu.js,
// app.js client wiring). Nothing in those steps is rebuilt here.
//
// This module does NOT introduce a second room/seat/reconnect authority.
// It hangs small, fire-and-forget hooks off the EXISTING single points
// where server.js already knows a lifecycle fact happened:
//   - room created:   POST /api/room/create, right after `rooms[roomId] = room`
//   - room closed:    DELETE /api/admin/rooms/:roomId, and the `close-room`
//                      socket event — the app's only two room-delete sites
//   - a user left the room, for ANY reason (explicit leave, kick, close-room
//     member-clear, or disconnect-grace-period expiry): the single shared
//     handleUserLeaveRoom() function
//   - disconnect grace period started/resolved: the exact pendingDisconnects
//     set/clear call sites already used for the mesh reconnect UX
//   - a ghost seat was cleared by room-recovery.js's existing sweep
//   - a seat was taken / released / moved: the existing take-seat,
//     leave-seat, mod-move-seat, mod-move-to-audience socket handlers
//
// Every exported function is:
//   1. A no-op if VOICE_MODE !== "sfu" (checked first, before touching
//      livekit.js at all) — a mesh-only deployment's timing/behavior at
//      every one of the call sites above is completely unaffected.
//   2. Fire-and-forget from the caller's point of view — callers never
//      await these (matches this codebase's existing pattern of not
//      letting best-effort telemetry/side-effect calls block a request or
//      socket handler; see voice_sfu/index.js's own sfuHealth.recordJoin
//      calls for the same style).
//   3. Wrapped so a LiveKit API failure can NEVER throw into its caller —
//      only logged and recorded via sfuHealth (Step 3.4 spec requirement
//      #8, "fail-safe: LiveKit unavailable must not crash the app").
//
// CLUSTER COMPATIBILITY (spec requirement #5): every action this module
// takes is a call to LiveKit's own server-admin REST API (RoomServiceClient,
// via livekit.js) — LiveKit itself is the single shared source of truth
// across every PingPong instance, the same way Redis is the shared source
// of truth for presence/room-state mirroring (see redis/roomState.js's own
// header). Any instance calling deleteRoom/removeParticipant/updateParticipant
// affects the actual shared LiveKit room, not instance-local state, so this
// module needs no Redis pub/sub coordination layer of its own — building
// one would be exactly the kind of duplicate synchronization system the
// spec says not to add. The only per-instance-local state involved
// (roomManager.js's `participantCounts`) was already documented in Step 3.2
// as best-effort bookkeeping, not authorization or a cleanup precondition.

function initVoiceSfuSync({ roomManager, livekit, sfuHealth }) {
    // PHASE 3, STEP 3.5: was a single global VOICE_MODE==="sfu" check.
    // Now delegates to provider.js's per-room resolution so a "staged"
    // rollout (see rollout.js) is honored correctly here too — a room
    // that the staged config puts on SFU gets real LiveKit lifecycle
    // sync (cleanup, force-disconnect, publish-permission enforcement);
    // a room the staged config leaves on mesh gets none of these calls,
    // exactly as if VOICE_MODE were plain "mesh" for that room. Every
    // exported function below already receives roomId as its first
    // argument, so this is a drop-in replacement with no call-site
    // signature changes. For plain VOICE_MODE=mesh/sfu (Steps 3.1-3.4's
    // only supported values) this resolves to exactly what the old
    // sfuActive() did — no behavior change for a non-staged deployment.
    const { effectiveVoiceModeForRoom } = require("./provider.js");
    function sfuActiveForRoom(roomId) {
        return effectiveVoiceModeForRoom({ roomId, roomManager }) === "sfu";
    }

    // Every real LiveKit call in this module goes through here: no-ops
    // instantly (before any require/network work) in mesh mode, times the
    // call for health.js's liveKitApiLatencyMs metric, and swallows any
    // failure (logged + recorded, never thrown) — "participant/room not
    // found" is an ordinary, frequent, non-fatal outcome here (it just
    // means that identity/room never had or no longer has an SFU
    // connection), not a bug to surface to the caller.
    // PHASE 3, STEP 3.6 — categorizes each hook's latency sample for
    // health.js's new per-operation breakdown (spec item 4), purely from
    // the SAME `label` string every call site here already passes for
    // its log line — no new parameter added to any call site, no
    // behavior change if sfuHealth.recordApiLatency ever receives an
    // unrecognized category (it just isn't bucketed further; the
    // existing generic apiLatenciesMs recording is unaffected either
    // way, see health.js).
    function categoryForLabel(label) {
        if (label.indexOf("onSeatChanged") === 0) return "permissionUpdate";
        if (label.indexOf("onRoomClosed") === 0 || label.indexOf("onRoomPossiblyEmpty") === 0) return "cleanup";
        if (label.indexOf("onParticipantGraceStart") === 0 || label.indexOf("onParticipantGraceResumed") === 0) return "reconnect";
        return "livekitApi"; // onParticipantLeftRoom / onGhostSeatCleared and anything else — generic LiveKit API call
    }

    // ROOT-CAUSE FIX (2026-08-10, "participant does not exist" noise on
    // onSeatChanged): distinguishes the ONE genuinely expected race —
    // a seat is taken server-side, this hook fires immediately, but the
    // client's separate LiveKit connect() call hasn't landed yet — from
    // every other kind of LiveKit API failure. Detected the same way the
    // logs themselves already show it (LiveKit's own "not found"/"does
    // not exist" wording), not by a wider try/catch. This is deliberately
    // NOT reused for onParticipantLeftRoom: if a participant to be
    // REMOVED doesn't exist, that's already the converged end state —
    // retrying can't make a leave more true. It only helps onSeatChanged,
    // where the participant may legitimately come into existence a moment
    // later.
    function looksLikeNotFound(e) {
        const msg = ((e && e.message) || String(e)).toLowerCase();
        return msg.indexOf("not found") !== -1 || msg.indexOf("does not exist") !== -1;
    }
    // Mobile/browser SFU joins can legitimately take several seconds after a
    // seat event. Use bounded exponential convergence instead of a single
    // 1.5s retry, while keeping all retries idempotent and non-blocking to the
    // socket/room operation itself.
    const SEAT_SYNC_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
    function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    async function safe(roomId, label, fn, { retryOnNotFound = false } = {}) {
        if (!sfuActiveForRoom(roomId)) return;
        const startedAt = Date.now();
        const category = categoryForLabel(label);
        try {
            await fn();
            if (sfuHealth) sfuHealth.recordApiLatency(Date.now() - startedAt, category);
            return;
        } catch (e) {
            if (sfuHealth) sfuHealth.recordApiLatency(Date.now() - startedAt, category);
            const msg = (e && e.message) || String(e);
            const expectedRace = retryOnNotFound && looksLikeNotFound(e);
            if (expectedRace) {
                // EXPECTED IDEMPOTENT RACE — one bounded retry, then converge
                // silently either way. Logged distinctly from a real failure
                // per the task's observability requirement (never flood logs,
                // never hide a genuine failure).
                for (const delay of SEAT_SYNC_RETRY_DELAYS_MS) {
                    await sleep(delay);
                    if (!sfuActiveForRoom(roomId)) return;
                    try {
                        await fn();
                        console.log(`[voice_sfu:sync] ${label}: participant permission converged after retry`);
                        return;
                    } catch (e2) {
                        if (!looksLikeNotFound(e2)) {
                            console.warn(`[voice_sfu:sync] ${label} retry failed with a REAL error (non-fatal): ${(e2 && e2.message) || e2}`);
                            if (sfuHealth) sfuHealth.recordError({ message: `${label} retry: ${(e2 && e2.message) || e2}` });
                            return;
                        }
                    }
                }
                console.log(`[voice_sfu:sync] ${label}: participant still not connected after bounded retries; fresh token permissions remain authoritative`);
                return;
            }
            console.warn(`[voice_sfu:sync] ${label} failed (non-fatal): ${msg}`);
            if (sfuHealth) sfuHealth.recordError({ message: `${label}: ${msg}` });
        }
    }

    // ---------------- Room lifecycle ----------------

    // PingPong room created (POST /api/room/create). Deliberately does NOT
    // proactively create a matching LiveKit room — LiveKit room creation
    // stays lazy, on the first /api/voice-sfu/join for that room (see
    // provider.js's SFUProvider.getConnectionInfo, unchanged by this step).
    // Proactively creating one here would itself risk the "orphan LiveKit
    // room" outcome this step exists to prevent, for the many PingPong
    // rooms that never end up using voice at all. Kept as a named hook
    // (rather than omitted) for symmetry with onRoomClosed below and as an
    // explicit extension point, and because it's a useful log line for
    // tracing PingPong-room-id <-> LiveKit-room-name lifecycles end to end.
    function onRoomCreated(roomId) {
        if (!sfuActiveForRoom(roomId)) return;
        console.log(`[voice_sfu:sync] PingPong room created: ${roomId} (LiveKit room created lazily on first SFU join)`);
    }

    // PingPong room closed — called from BOTH of this app's two room-delete
    // call sites (admin DELETE /api/admin/rooms/:roomId, and the host's
    // `close-room` socket event). Deletes the mapped LiveKit room
    // immediately. This is a STRONGER guarantee layered on top of the
    // existing safety net already built in Step 3.2 (livekit.js's
    // ensureRoom sets a 5-minute emptyTimeout on every LiveKit room) — not
    // a replacement for it: if this call never fires (a crash mid-request,
    // before this line runs), that existing timeout still reclaims the
    // LiveKit room on its own a few minutes later. No orphan can outlive
    // both of these.
    function onRoomClosed(roomId) {
        return safe(roomId, `onRoomClosed(${roomId})`, async () => {
            const name = roomManager.toLiveKitRoomName(roomId);
            await livekit.deleteRoom(name);
            roomManager.clearLocalCount(name);
            if (sfuHealth) sfuHealth.recordCleanup({ roomId });
            console.log(`[voice_sfu:sync] LiveKit room deleted for closed PingPong room ${roomId}`);
        });
    }

    // PingPong room's last online user just left (called from
    // handleUserLeaveRoom once room.onlineUsers.length reaches 0 — see
    // §"Participant lifecycle" below for that same call site's other
    // hook). Does NOT delete immediately: someone could rejoin within
    // seconds and a still-connecting SFU participant on another instance
    // could legitimately be mid-handshake. Schedules a single delayed
    // re-check per room (existing timer for that room is replaced, not
    // stacked) that only deletes if BOTH (a) the PingPong room is still
    // empty at check time, re-read live via roomManager.getPingPongRoom
    // (not the possibly-stale value from when this was scheduled), AND
    // (b) LiveKit's OWN listParticipants for that room reports zero — the
    // real, cluster-wide source of truth, so an instance can never delete
    // a LiveKit room another instance's user is still actually connected
    // to just because ITS local bookkeeping looked empty.
    const emptyRoomTimers = new Map(); // pingpongRoomId -> Timeout
    const EMPTY_ROOM_RECHECK_DELAY_MS = 60 * 1000; // matches room-recovery.js's own ghost-sweep cadence

    function onRoomPossiblyEmpty(roomId, isCurrentlyEmpty) {
        if (!sfuActiveForRoom(roomId)) return;
        const existingTimer = emptyRoomTimers.get(roomId);
        if (existingTimer) { clearTimeout(existingTimer); emptyRoomTimers.delete(roomId); }
        if (!isCurrentlyEmpty) return; // someone's still there (or came back) — nothing to schedule

        const timer = setTimeout(() => {
            emptyRoomTimers.delete(roomId);
            safe(roomId, `onRoomPossiblyEmpty(${roomId})`, async () => {
                const room = roomManager.getPingPongRoom(roomId);
                if (room && Array.isArray(room.onlineUsers) && room.onlineUsers.length > 0) return; // someone came back
                const name = roomManager.toLiveKitRoomName(roomId);
                const participants = await livekit.listParticipants(name);
                if (Array.isArray(participants) && participants.length > 0) return; // LiveKit says someone's still connected — leave it alone
                await livekit.deleteRoom(name);
                roomManager.clearLocalCount(name);
                if (sfuHealth) sfuHealth.recordCleanup({ roomId });
                console.log(`[voice_sfu:sync] LiveKit room cleaned up for empty PingPong room ${roomId}`);
            });
        }, EMPTY_ROOM_RECHECK_DELAY_MS);
        timer.unref();
        emptyRoomTimers.set(roomId, timer);
    }

    // ---------------- Participant lifecycle ----------------

    // Any confirmed leave — kick, close-room member-clear, explicit
    // leave-room, or a disconnect-grace-period expiry — all funnel through
    // the ONE shared handleUserLeaveRoom() in server.js, so this is called
    // from that single spot. Best-effort force-disconnects that identity
    // from the mapped LiveKit room, so a crashed/frozen client can't keep
    // publishing/subscribing audio in a room PingPong no longer considers
    // them part of. A well-behaved client also calls POST
    // /api/voice-sfu/leave itself on a graceful exit (Step 3.2) — that
    // route's roomManager.recordLeave() is local-count bookkeeping only
    // and never actually calls LiveKit; this is the authoritative
    // server-side backstop that covers every OTHER case (crash, force-kick,
    // grace-period expiry) that route is never reached for.
    function onParticipantLeftRoom(roomId, userId) {
        return safe(roomId, `onParticipantLeftRoom(${roomId},${userId})`, async () => {
            const name = roomManager.toLiveKitRoomName(roomId);
            await livekit.removeParticipant(name, userId);
        });
    }

    // Ghost seat forcibly cleared by room-recovery.js's existing sweep
    // (stale seat: no live socket AND no pending grace timer — genuinely
    // gone, not mid-reconnect). Functionally identical to
    // onParticipantLeftRoom, exposed under its own name so
    // room-recovery.js's hook call site reads clearly for what triggered
    // it (recovery-driven, not an ordinary leave).
    function onGhostSeatCleared(roomId, userId) {
        return onParticipantLeftRoom(roomId, userId);
    }

    // Disconnect grace period just started (pendingDisconnects[uid] was
    // just set in server.js's socket "disconnect" handler). Tags the
    // LiveKit participant's metadata so anything reading it (a future
    // admin dashboard, LiveKit's own server-side logs) can tell
    // "mid-reconnect" apart from solidly connected — a LiveKit-side echo
    // of the EXACT same fact voice-reconnect.js already broadcasts to mesh
    // peers over Socket.IO (`voice-peer-reconnecting`), not a second
    // source of truth for it. Does NOT remove/disconnect the participant —
    // their underlying SFU media connection is independent of the
    // Socket.IO connection that just dropped and may still be alive and
    // actively reconnecting on LiveKit's side.
    function onParticipantGraceStart(roomId, userId) {
        // PHASE 3, STEP 3.5 fix: this counter used to increment for EVERY
        // grace-start call regardless of mode, which meant a mesh-only
        // deployment (or, worse, a staged rollout with a mix of mesh and
        // SFU rooms) would see reconnectEventCount rise for rooms that
        // never touched LiveKit at all — a meaningless number for an
        // operator trying to read SFU-side reconnect health off it. Now
        // only counted for rooms actually on the SFU side of the current
        // mode/rollout decision, same gate as every other action here.
        if (sfuHealth && sfuActiveForRoom(roomId)) sfuHealth.recordReconnectEvent();
        return safe(roomId, `onParticipantGraceStart(${roomId},${userId})`, async () => {
            const name = roomManager.toLiveKitRoomName(roomId);
            await livekit.updateParticipant(name, userId, { metadata: { pingpongRoomId: roomId, reconnecting: true } });
        });
    }

    // Grace period cancelled — the user reconnected in time (join-room
    // found and cleared a live pendingDisconnects entry for them). Clears
    // the "reconnecting" metadata tag set above.
    function onParticipantGraceResumed(roomId, userId) {
        return safe(roomId, `onParticipantGraceResumed(${roomId},${userId})`, async () => {
            const name = roomManager.toLiveKitRoomName(roomId);
            await livekit.updateParticipant(name, userId, { metadata: { pingpongRoomId: roomId, reconnecting: false } });
        });
    }

    // Seat taken / released / moved (take-seat, leave-seat, mod-move-seat,
    // mod-move-to-audience). Refreshes LiveKit participant metadata AND —
    // this is the part that matters for spec requirement #3 ("Only seated
    // users may publish. Audience remains listeners.") — updates their
    // actual LiveKit publish permission to match. Today's token minting
    // (token.js) only ever hands a token to an already-seated user with
    // canPublish:true baked in at mint time; if that same user is later
    // moved to audience (mod-move-to-audience) or their seat changes while
    // their LiveKit connection stays open, nothing previously revoked that
    // baked-in permission. This closes that gap by re-asserting the
    // CURRENT, correct permission every time a seat event happens, read
    // straight from the caller's already-known seat/role state — this
    // function never re-derives or stores that state itself, and LiveKit
    // remains a pure mirror of it, never an independent authority (per
    // spec requirement #4, "never duplicate PingPong state").
    function onSeatChanged(roomId, userId, { seatNumber = null, isHost = false, isModerator = false, canPublish = true } = {}) {
        return safe(roomId, `onSeatChanged(${roomId},${userId})`, async () => {
            const name = roomManager.toLiveKitRoomName(roomId);
            await livekit.updateParticipant(name, userId, {
                metadata: {
                    pingpongRoomId: roomId,
                    seatNumber,
                    host: !!isHost,
                    moderator: !!isModerator,
                    canPublish: !!canPublish
                },
                permission: {
                    canPublish: !!canPublish,
                    canSubscribe: true,
                    canPublishData: true
                }
            });
            // PHASE 3, STEP 3.6 — keeps roomManager's best-effort publisher
            // bookkeeping (used by health.js/admin metrics, never for
            // authorization) accurate across EVERY seat transition, not
            // just the initial /join. This matters now that a client
            // upgrading from audience to seated publishes onto its
            // EXISTING LiveKit connection in place (see
            // PHASE3_STEP36_REPORT.md) rather than calling /join again —
            // without this line, that upgrade would never be reflected in
            // the publisher count.
            roomManager.setPublisherStatus(name, userId, !!canPublish);
        }, { retryOnNotFound: true }); // ROOT-CAUSE FIX (2026-08-10) — see safe()'s comment above: bounded, single, expected-race-only retry for the "seat taken before client's LiveKit connect() landed" case
    }

    return {
        onRoomCreated,
        onRoomClosed,
        onRoomPossiblyEmpty,
        onParticipantLeftRoom,
        onGhostSeatCleared,
        onParticipantGraceStart,
        onParticipantGraceResumed,
        onSeatChanged
    };
}

module.exports = { initVoiceSfuSync };
