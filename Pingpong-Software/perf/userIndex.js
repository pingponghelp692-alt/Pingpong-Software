// ==================================================
// PHASE 11 — O(1) USER-ID INDEX (additive)
// ==================================================
// The problem this fixes: server.js's findUserByUserId(userId) did
// Object.keys(users).find(m => users[m].userId === userId) — a full
// linear scan of every user on every call. That function is called from
// 100+ call sites across server.js (71), svip.js (9), banManagement.js
// (5), diamondSeller.js (4), vipApproval.js (3), agencyHost.js (6), and
// coinCenter.js (6) — including inside loops (e.g. analyticsHub.js's
// revenue aggregation calls it once per transaction). That made it
// O(users) per call and O(transactions × users) for that aggregation —
// the single worst algorithmic hotspot in the codebase, and it gets
// quadratically worse as the user base grows.
//
// The fix: maintain a userId -> mobile Map alongside `users`, updated at
// the same two places a user is ever created (verify-otp, set-password)
// and the one place a user is ever deleted (admin delete). Confirmed by
// reading server.js: `users` itself is only ever mutated in place, never
// reassigned, and `.userId` is never changed after creation — so a
// Map built once at startup and kept in sync at those 3 sites stays
// correct for the process lifetime.
//
// Self-healing by design: if a lookup ever misses the index (e.g. some
// future code path creates a user without going through indexUser — a
// mistake this module can't rule out for code added later), it falls
// back to the original linear scan AND repairs the index from that
// result, so correctness is preserved even if the index is incomplete;
// only that one lookup pays the O(n) cost, not every subsequent one.

function attachIndex(users) {
    const userIdToMobile = new Map();
    for (const mobile of Object.keys(users)) {
        const u = users[mobile];
        if (u && u.userId) userIdToMobile.set(u.userId, mobile);
    }

    function indexUser(mobile, user) {
        if (user && user.userId) userIdToMobile.set(user.userId, mobile);
    }

    function unindexUser(userId) {
        if (userId) userIdToMobile.delete(userId);
    }

    function findUserByUserId(userId) {
        const mobile = userIdToMobile.get(userId);
        if (mobile && users[mobile]) return { mobile, user: users[mobile] };
        // Index miss — fall back to the original O(n) scan and self-heal.
        // Covers: index truly doesn't have it (not found at all), or a
        // stale mapping (mobile no longer resolves, e.g. race with
        // deletion) — either way, trust `users` as ground truth.
        const foundMobile = Object.keys(users).find((m) => users[m].userId === userId);
        if (!foundMobile) {
            if (mobile) userIdToMobile.delete(userId); // stale entry, clean it up
            return null;
        }
        userIdToMobile.set(userId, foundMobile); // repair
        return { mobile: foundMobile, user: users[foundMobile] };
    }

    return { indexUser, unindexUser, findUserByUserId, _index: userIdToMobile };
}

module.exports = { attachIndex };
