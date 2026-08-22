// ==================================================
// SOCKET IDENTITY GUARD (Phase 1 — Firebase/Identity Audit, 2026-08-10)
// ==================================================
// FINDING (see FIREBASE_IDENTITY_AUDIT.md, item AUTH-1): the "identify"
// socket event (Module 5.1, 2026-08-08) verifies a claimed userId against
// authToken and sets socket.authedUserId on success — but "join-room"
// still set socket.userId directly from the client-supplied payload with
// NO check against that verified identity. Since socket.userId is the
// value every other room handler trusts (send-message, take-seat, gifts,
// and isOwnerOrAdmin() for every mod/host action), a socket that had
// already verified as user A could emit join-room with user B's userId
// (or vice versa: any socket, verified or not, could claim to be a room's
// host) and every subsequent action in that room ran as the claimed
// identity instead of the verified one. This module closes that gap.
//
// Policy mirrors the "identify" event's own staged rollout and
// userAuth.requireUserAuth's fail-open-for-legacy-clients policy:
//   - Socket has NOT yet verified an identity this connection (no prior
//     successful "identify" with a valid authToken) -> still allowed
//     unverified, same as before this fix. Not a regression for any
//     legacy client that never sends authToken.
//   - Socket HAS a verified authedUserId (identify succeeded) and now
//     tries to join-room as a DIFFERENT userId -> rejected outright. This
//     is never a legitimate case (a legitimate client always identifies
//     and joins as itself) and is either a client bug or an impersonation
//     attempt.
//
// Pure function, no I/O, so it's directly unit-testable without spinning
// up a real Socket.IO server — see test/socketIdentityGuard.test.js.
function isJoinIdentityAllowed(authedUserId, claimedUserId) {
    if (!authedUserId) return true; // not yet verified on this socket — fail open (legacy client), unchanged from prior behavior
    return authedUserId === claimedUserId;
}

module.exports = { isJoinIdentityAllowed };
