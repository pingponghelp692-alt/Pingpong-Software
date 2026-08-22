// badges.js
// ==================================================
// PREMIUM BADGE SYSTEM (Blue Diamond V, additive)
// ==================================================
// Purely additive module, same pattern as vehicles.js/callSignaling.js: one
// init function wires a couple of REST routes off the existing `app`, using
// the shared findUserByUserId/saveUsers/socketsByUserId/io primitives — no
// new DB, no new socket connection block, no change to any existing route.
//
// Badges are admin-only-grantable ("not public" — a user can never give
// themselves one). Fully controlled from the Admin Panel via
// /api/admin/badges/send and /api/admin/badges/remove. Visibility for a
// user always comes straight from data/users.json's `activeBadges` array
// (default []) — nothing else gates it. A separate append-only audit log,
// data/badgeTransactions.json, records every send/remove action.
//
// EVENT NAME NOTE: svip.js already emits a "badge_update" socket event for
// a *different*, single-badge SVIP concept ({ userId, badge }). Reusing
// that name here for a different, multi-badge payload shape would create
// an ambiguous collision for any future listener. This module emits
// "user_badges_update" instead — a new, distinct event name. svip.js and
// its "badge_update" event are completely untouched.

const path = require("path");

// Extensible catalog — add more entries here later without touching the
// route logic below. `imageUrl` is the static asset served from /public.
// seatSize/profileSize are DEFAULTS only — the actual size shown is
// whatever's saved in data/badgeSizes.json (below), so admin can resize
// per-badge without a code change/restart.
const BADGE_CATALOG = [
    { id: "blue_diamond_v", name: "Blue Diamond V", imageUrl: "/images/badges/blue_diamond_v.png", seatSize: 16, profileSize: 72 }
];

// Reasonable guardrails so a typo in the admin panel can't render a
// badge that's invisible (0px) or breaks layout (huge). Room Seat stays
// small (it sits on an already-small avatar circle); Profile can go
// bigger since it floats above open space.
const SEAT_SIZE_MIN = 8, SEAT_SIZE_MAX = 40;
const PROFILE_SIZE_MIN = 24, PROFILE_SIZE_MAX = 160;


function initBadges({ app, DATA_FOLDER, safeRead, safeWrite, findUserByUserId, saveUsers, io, socketsByUserId, emitToUser, syncProfileToRoom, rbac, requireAdmin, requirePermission, reqUserAgent }) {
    const TX_FILE = path.join(DATA_FOLDER, "badgeTransactions.json");
    let badgeTransactions = safeRead(TX_FILE, []);
    function saveTransactions() { safeWrite(TX_FILE, badgeTransactions); }

    // Per-badge size overrides, admin-editable — SIZE ADJUSTMENT (2026-08-05).
    // Keyed by badge_id: { seatSize, profileSize } in px. Missing/unedited
    // badges just fall back to their BADGE_CATALOG defaults above, so this
    // file can start out empty/missing with zero behavior change.
    const SIZES_FILE = path.join(DATA_FOLDER, "badgeSizes.json");
    let badgeSizes = safeRead(SIZES_FILE, {});
    function saveSizes() { safeWrite(SIZES_FILE, badgeSizes); }

    function catalogBadge(badgeId) {
        return BADGE_CATALOG.find((b) => b.id === badgeId);
    }

    // Merges each catalog entry with any saved size override — this is the
    // shape both the admin panel and the public client actually consume,
    // so neither has to know the override file exists.
    function catalogWithSizes() {
        return BADGE_CATALOG.map((b) => {
            const override = badgeSizes[b.id];
            return {
                ...b,
                seatSize: (override && override.seatSize) || b.seatSize,
                profileSize: (override && override.profileSize) || b.profileSize
            };
        });
    }

    function logTransaction({ userId, badgeId, action, sentBy }) {
        const entry = {
            id: "btx_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            user_id: userId,
            pingpong_id: userId, // PingPong ID *is* userId in this codebase — same value, kept under both keys to match the audit-log shape requested
            badge_id: badgeId,
            action, // "send" | "remove"
            sent_by: sentBy,
            created_at: new Date().toISOString()
        };
        badgeTransactions.push(entry);
        if (badgeTransactions.length > 5000) badgeTransactions = badgeTransactions.slice(-5000);
        saveTransactions();
        return entry;
    }

    // Private to the affected user only — never a broadcast. Also nudges
    // the room-state sync so anyone else looking at that user's seat sees
    // the badge appear/disappear immediately, without an app restart.
    // GAP #1 — cross-instance-safe via emitToUser()
    function notifyUser(userId, activeBadges) {
        emitToUser(userId, "user_badges_update", { userId, badges: activeBadges });
        if (typeof syncProfileToRoom === "function") syncProfileToRoom(userId);
    }

    function actorTag(req) {
        return req.adminAccount ? { id: req.adminAccount.id, username: req.adminAccount.username } : null;
    }

    // ---------------- Admin: catalog (for the Badge dropdown) ----------------
    app.get("/api/admin/badges/catalog", requireAdmin, requirePermission("badges:manage"), (req, res) => {
        res.json({ success: true, catalog: catalogWithSizes() });
    });

    // ---------------- Public: catalog with sizes ----------------
    // Read-only, no auth — the client (Room Seat + Profile rendering) needs
    // this to know the current admin-configured px size for each badge.
    // No user data here, just id/name/imageUrl/sizes, same as any other
    // static asset config (frames, gifts, etc. already expose similar
    // public catalog endpoints elsewhere in this codebase).
    app.get("/api/badges/catalog", (req, res) => {
        res.json({ success: true, catalog: catalogWithSizes() });
    });

    // ---------------- Admin: resize a badge (Room Seat / Profile, independently) ----------------
    app.post("/api/admin/badges/size", requireAdmin, requirePermission("badges:manage"), (req, res) => {
        const badgeId = String((req.body && req.body.badge_id) || "").trim();
        if (!badgeId || !catalogBadge(badgeId)) return res.json({ success: false, message: "Unknown badge_id" });
        let seatSize = Number(req.body && req.body.seatSize);
        let profileSize = Number(req.body && req.body.profileSize);
        if (!Number.isFinite(seatSize)) seatSize = (badgeSizes[badgeId] && badgeSizes[badgeId].seatSize) || catalogBadge(badgeId).seatSize;
        if (!Number.isFinite(profileSize)) profileSize = (badgeSizes[badgeId] && badgeSizes[badgeId].profileSize) || catalogBadge(badgeId).profileSize;
        seatSize = Math.round(Math.min(SEAT_SIZE_MAX, Math.max(SEAT_SIZE_MIN, seatSize)));
        profileSize = Math.round(Math.min(PROFILE_SIZE_MAX, Math.max(PROFILE_SIZE_MIN, profileSize)));
        badgeSizes[badgeId] = { seatSize, profileSize };
        saveSizes();
        // Broadcast, not per-user — a size change affects how the badge
        // renders for every viewer, not just the badge's owner, so this is
        // the one badges.js event that goes to everyone online rather than
        // a single socket. Still config-only (id/px numbers), no user data.
        io.emit("badge_catalog_update", { catalog: catalogWithSizes() });
        rbac.logAction({ admin: req.adminAccount, action: "badge-resize", module: "badges", targetType: "badge", targetId: badgeId, after: { seatSize, profileSize }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, badge: { id: badgeId, seatSize, profileSize } });
    });

    // ---------------- Admin: Send Badge ----------------
    app.post("/api/admin/badges/send", requireAdmin, requirePermission("badges:manage"), (req, res) => {
        const pingpongId = String((req.body && req.body.pingpong_id) || "").trim();
        const badgeId = String((req.body && req.body.badge_id) || "").trim();
        if (!pingpongId || !badgeId) return res.json({ success: false, message: "pingpong_id and badge_id are required" });
        const found = findUserByUserId(pingpongId);
        if (!found) return res.json({ success: false, message: "User not found" });
        const badge = catalogBadge(badgeId);
        if (!badge) return res.json({ success: false, message: "Unknown badge_id" });
        const user = found.user;
        if (!Array.isArray(user.activeBadges)) user.activeBadges = [];
        if (user.activeBadges.includes(badgeId)) {
            // Already has it — spec says do nothing, still a success response.
            return res.json({ success: true, badges: user.activeBadges });
        }
        user.activeBadges.push(badgeId);
        saveUsers();
        logTransaction({ userId: user.userId, badgeId, action: "send", sentBy: actorTag(req) });
        notifyUser(user.userId, user.activeBadges);
        rbac.logAction({ admin: req.adminAccount, action: "badge-send", module: "badges", targetType: "user", targetId: user.userId, after: { badge_id: badgeId }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, badges: user.activeBadges });
    });

    // ---------------- Admin: Remove Badge ----------------
    app.post("/api/admin/badges/remove", requireAdmin, requirePermission("badges:manage"), (req, res) => {
        const pingpongId = String((req.body && req.body.pingpong_id) || "").trim();
        const badgeId = String((req.body && req.body.badge_id) || "").trim();
        if (!pingpongId || !badgeId) return res.json({ success: false, message: "pingpong_id and badge_id are required" });
        const found = findUserByUserId(pingpongId);
        if (!found) return res.json({ success: false, message: "User not found" });
        const user = found.user;
        if (!Array.isArray(user.activeBadges)) user.activeBadges = [];
        const had = user.activeBadges.includes(badgeId);
        user.activeBadges = user.activeBadges.filter((b) => b !== badgeId);
        saveUsers();
        if (had) {
            logTransaction({ userId: user.userId, badgeId, action: "remove", sentBy: actorTag(req) });
            notifyUser(user.userId, user.activeBadges);
            rbac.logAction({ admin: req.adminAccount, action: "badge-remove", module: "badges", targetType: "user", targetId: user.userId, before: { badge_id: badgeId }, ip: req.ip, userAgent: reqUserAgent(req) });
        }
        res.json({ success: true, badges: user.activeBadges });
    });

    // ---------------- Public: a user's own badge list ----------------
    // (Used by the client to hydrate a profile view; returning only the
    // badge id list here, same shape the spec asked for — not the full
    // user record.)
    app.get("/api/user/:pingpongId/badges", (req, res) => {
        const found = findUserByUserId(req.params.pingpongId);
        if (!found) return res.json({ success: false, message: "User not found" });
        res.json({ success: true, badges: found.user.activeBadges || [] });
    });

    // ---------------- Admin: audit log ----------------
    app.get("/api/admin/badges/history", requireAdmin, requirePermission("badges:manage"), (req, res) => {
        const pingpongId = req.query.pingpong_id;
        const list = pingpongId ? badgeTransactions.filter((t) => t.pingpong_id === pingpongId) : badgeTransactions;
        res.json({ success: true, history: list.slice(-200).reverse() });
    });

    return { BADGE_CATALOG, catalogBadge };
}

module.exports = { initBadges, BADGE_CATALOG };
