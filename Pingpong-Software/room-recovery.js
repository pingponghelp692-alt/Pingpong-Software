// room-recovery.js
// ==================================================
// PHASE 1 (Tier A) — ROOM RECOVERY MANAGER (scoped)
// ==================================================
// IMPORTANT — read before extending this file:
// The original Tier A spec for this module listed "Host Disconnect ->
// Auto Host Transfer". server.js already has an explicit, documented,
// deliberate fix that REMOVES exactly that behavior (see server.js,
// handleUserLeaveRoom(), "AUDIT FIX (2026-07-27, permanent-ownership)"):
// room ownership is intentionally permanent and must never silently move
// to another user just because the owner is offline. Implementing
// auto-transfer here would revert that fix and break a feature this
// codebase's owner economy (SVIP/agency/diamond systems) explicitly
// relies on. So this module does NOT do host transfer, automatic or
// otherwise. If a "temporary co-host while I'm away" feature is wanted
// later, it should be an explicit, owner-initiated action (a new
// `transfer-host`/`delegate-host` socket event the owner triggers on
// purpose) — a real feature to design deliberately, not something to
// bolt on inside a "recovery" module as a side effect of a timer.
//
// What this module DOES do — the two Tier A items that don't conflict
// with anything existing:
//
//   1. Ghost seat cleanup: a seat can end up occupied by a userId with
//      no live connection AND no pending disconnect-grace timer. This
//      happens after a crash/restart (in-memory pendingDisconnects and
//      socketsByUserId are wiped, but rooms.json's seats were persisted
//      mid-occupancy) or a rare split-brain edge case. This is NOT the
//      permanent-ownership case above — a seat is a live "who is
//      currently sitting here" fact, not room ownership/metadata, so
//      clearing a stale seat is exactly the kind of cleanup the
//      permanence fix explicitly said was still fine ("An admin cleanup
//      tool... not a silent automatic one" is about deleting rooms; this
//      never deletes a room, ever, only clears seats nobody occupies).
//
//   2. Boot-time recovery sweep: on process start, any seat whose userId
//      has no corresponding live socket yet (nobody has reconnected
//      since the restart) is cleared so the room doesn't show "occupied"
//      seats that are actually just stale disk state from before the
//      restart. Runs once, after socketsByUserId exists but before the
//      server starts accepting connections, so it can't race a genuinely
//      fast-reconnecting user.
//
// FUTURE-COMPATIBILITY NOTE (Tier B): this module only ever reads/writes
// the SAME `rooms` object server.js already owns and calls the SAME
// `saveRoomsToDisk`/io.to(...).emit(...) patterns already in use — no
// separate store, no new persistence format. When state moves to
// Redis, this module's two sweeps become "iterate the shared room set"
// instead of "iterate the local object" — the ghost-detection logic
// itself (live socket vs. recorded seat) doesn't change, only where
// "live socket" is looked up (still per-instance socketsByUserId locally,
// or a shared presence set in Redis after migration).

const GHOST_SWEEP_INTERVAL_MS = 60 * 1000;

// PHASE 3, STEP 3.4 addition: optional `onGhostSeatCleared(roomId, userId)`
// hook, called for each ghost seat this module's existing sweep clears —
// wired by server.js to voice_sfu/sync.js's onGhostSeatCleared() so a
// stale SFU/LiveKit participant connection (from the same crash/restart
// that left the ghost seat behind) gets force-disconnected too. Optional
// and defaulted to a no-op so every other caller of this module, and every
// deployment not running VOICE_MODE=sfu, is completely unaffected — the
// ghost-seat detection/clearing logic itself (see header above) is
// unchanged.
function initRoomRecovery({ io, rooms, socketsByUserId, pendingDisconnects, saveRoomsToDisk, publicRoom, onGhostSeatCleared }) {
    const notifyGhostSeatCleared = typeof onGhostSeatCleared === "function" ? onGhostSeatCleared : () => {};
    function isGhostSeat(userId) {
        // A seat is genuinely stale only if there's no live socket for
        // that user AND no in-flight grace-period timer that could still
        // legitimately reconnect them. Checking both avoids ripping a
        // seat out from under someone who dropped 2 seconds ago and is
        // actively reconnecting (see server.js's 30s grace period).
        if (socketsByUserId[userId]) return false;
        if (pendingDisconnects && pendingDisconnects[userId]) return false;
        return true;
    }

    function sweepGhostSeats({ isBootSweep = false } = {}) {
        let clearedCount = 0;
        for (const room of Object.values(rooms)) {
            if (!room.seats) continue;
            let roomChanged = false;
            room.seats.forEach((seat, i) => {
                if (!seat || !seat.userId) return;
                if (isGhostSeat(seat.userId)) {
                    console.log(`[room-recovery] ${isBootSweep ? "boot" : "periodic"} sweep: clearing ghost seat ${i + 1} in room ${room.roomId} (was ${seat.userId})`);
                    const ghostUserId = seat.userId;
                    room.seats[i] = null;
                    room.onlineUsers = (room.onlineUsers || []).filter((u) => u.userId !== ghostUserId);
                    roomChanged = true;
                    clearedCount++;
                    try { notifyGhostSeatCleared(room.roomId, ghostUserId); } catch (e) { console.warn(`[room-recovery] onGhostSeatCleared hook failed: ${e.message}`); }
                }
            });
            if (roomChanged) {
                io.to(room.roomId).emit("room-state", publicRoom(room));
                io.to(room.roomId).emit("user-count", { count: room.onlineUsers.length });
            }
        }
        if (clearedCount > 0) {
            saveRoomsToDisk();
            console.log(`[room-recovery] sweep complete: ${clearedCount} ghost seat(s) cleared`);
        }
        return clearedCount;
    }

    // Boot sweep: give a moment for reconnecting clients' "identify"/
    // rejoin traffic to land (they reconnect fast — socket.io client
    // config elsewhere in this app retries every 500ms-3s) before
    // declaring a seat abandoned. Short enough that a room doesn't look
    // wrongly "occupied" for long, long enough not to punish a slightly
    // slow first reconnect right after a deploy.
    function runBootSweep(delayMs = 10000) {
        setTimeout(() => sweepGhostSeats({ isBootSweep: true }), delayMs).unref();
    }

    setInterval(() => sweepGhostSeats({ isBootSweep: false }), GHOST_SWEEP_INTERVAL_MS).unref();

    return { sweepGhostSeats, runBootSweep };
}

module.exports = { initRoomRecovery };
