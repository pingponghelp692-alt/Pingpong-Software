// ==================================================
// SVIP Privilege System — Backend Core (additive module)
// ==================================================
// This file is self-contained and does not modify any existing wallet/VIP
// logic in server.js. It adds a *separate* SVIP1-8 "wealth level" system on
// top of the existing coins/diamonds/vipLevel fields, following the SRS:
//   - SVIP Resource Management (per-level resource mapping, cumulative)
//   - Dynamic Configuration (thresholds editable without app restart)
//   - Expiry System (permanent vs timed membership, auto-downgrade)
//   - Wealth History (audit log)
//   - SVIP History (level-change audit log)
//   - Socket Events (svip_level_changed, svip_resource_update, wealth_update)
//   - Notifications (level up, wealth added, expiring soon, expired)
//   - Anti-cheat helper (wealth_history vs current wealth consistency check)
//   - Leaderboard helper (daily/weekly/monthly/all-time)
//
// server.js is expected to call `initSvip({...})` once, after `users`,
// `io`, `socketsByUserId`, `findUserByUserId`, `saveUsers`, `safeRead`,
// `safeWrite` and `DATA_FOLDER` already exist, and to wire the returned
// functions in at the relevant points (login, gift-send, periodic sweep).
//
// NOTE ON "WEALTH": in this codebase gifts are bought with Coins (not
// Diamonds — see the "Changed on request" comments in server.js). SVIP
// wealth here is defined as *cumulative coins spent sending gifts*, which
// is the standard "Wealth level" definition used by BIGO/YoHo-style apps
// (a consumption metric, separate from the existing diamond-balance-based
// `vipLevel`). If a different definition is wanted (e.g. tied to Diamond
// recharge instead), only the call sites that invoke `addWealth()` need to
// change — the module itself is metric-agnostic.

const path = require("path");

function initSvip({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, emitToUser: crossInstanceEmitToUser, findUserByUserId, saveUsers, users }) {
    const SVIP_CONFIG_FILE = path.join(DATA_FOLDER, "svip_config.json");
    const SVIP_RESOURCE_FILE = path.join(DATA_FOLDER, "svip_resource.json");
    const WEALTH_HISTORY_FILE = path.join(DATA_FOLDER, "svip_wealth_history.json");
    const SVIP_HISTORY_FILE = path.join(DATA_FOLDER, "svip_history.json");
    const NOTIFICATIONS_FILE = path.join(DATA_FOLDER, "svip_notifications.json");

    const LEVEL_ORDER = ["SVIP1", "SVIP2", "SVIP3", "SVIP4", "SVIP5", "SVIP6", "SVIP7", "SVIP8"];

    // ---- Dynamic Configuration (Wealth Requirement Database) ----
    // Editable at runtime via setLevels() — no app restart needed, matching
    // the SRS requirement. Placeholder thresholds; tune freely later.
    const DEFAULT_CONFIG = {
        levels: {
            SVIP1: 300000,
            SVIP2: 1100000,
            SVIP3: 2500000,
            SVIP4: 5000000,
            SVIP5: 9000000,
            SVIP6: 15000000,
            SVIP7: 25000000,
            SVIP8: 40000000
        }
    };

    // ---- SVIP Resource Management ----
    // Placeholder/CSS-class-style resource identifiers per level (per your
    // choice) — real asset URLs/animation files can replace these string
    // IDs later without touching this module's logic. Levels are cumulative:
    // a SVIP5 user also has everything granted at SVIP1-4.
    const DEFAULT_RESOURCES = {
        SVIP1: { tag: "svip1-tag", badge: "svip1-badge", bubble: "svip1-bubble", frame: "svip1-frame" },
        SVIP2: { bubble: "svip2-bubble", frame: "svip2-frame" },
        SVIP3: { roomCard: "svip3-room-card", nicknameColor: "#E5B84B" },
        SVIP4: { roomCard: "svip4-room-card", nicknameColor: "#E5B84B" },
        SVIP5: { entryEffect: "svip5-entry" },
        SVIP6: { entryEffect: "svip6-entry", nicknameColor: "#FF7A45" },
        SVIP7: { animatedRoomTheme: "svip7-theme", entryEffect: "svip7-entry" },
        SVIP8: { animatedRoomTheme: "svip8-theme", entryEffect: "svip8-entry", exclusiveGift: "svip8-exclusive-gift" }
    };

    let config = safeRead(SVIP_CONFIG_FILE, DEFAULT_CONFIG);
    if (!config.levels) config.levels = DEFAULT_CONFIG.levels;
    let resourceMap = safeRead(SVIP_RESOURCE_FILE, DEFAULT_RESOURCES);
    safeWrite(SVIP_CONFIG_FILE, config);
    safeWrite(SVIP_RESOURCE_FILE, resourceMap);

    let wealthHistory = safeRead(WEALTH_HISTORY_FILE, []);
    let svipHistory = safeRead(SVIP_HISTORY_FILE, []);
    let notifications = safeRead(NOTIFICATIONS_FILE, []);

    function saveConfig() { safeWrite(SVIP_CONFIG_FILE, config); }
    function saveResources() { safeWrite(SVIP_RESOURCE_FILE, resourceMap); }
    function saveWealthHistory() {
        if (wealthHistory.length > 20000) wealthHistory.splice(0, wealthHistory.length - 20000);
        safeWrite(WEALTH_HISTORY_FILE, wealthHistory);
    }
    function saveSvipHistory() { safeWrite(SVIP_HISTORY_FILE, svipHistory); }
    function saveNotifications() {
        if (notifications.length > 5000) notifications.splice(0, notifications.length - 5000);
        safeWrite(NOTIFICATIONS_FILE, notifications);
    }

    function levelFromWealth(wealth) {
        let level = 0;
        for (const key of LEVEL_ORDER) {
            const threshold = config.levels[key];
            if (typeof threshold === "number" && wealth >= threshold) level = Number(key.replace("SVIP", ""));
        }
        return level;
    }

    // Cumulative resource set for a level (merges SVIP1..level).
    function resourcesForLevel(level) {
        let merged = {};
        for (let i = 1; i <= level; i++) {
            const key = "SVIP" + i;
            if (resourceMap[key]) merged = Object.assign({}, merged, resourceMap[key]);
        }
        return merged;
    }

    // Called for every user record on load/login so old accounts (created
    // before this module existed) get the new fields without disturbing
    // anything else already on the object.
    function ensureUserSvipFields(u) {
        if (typeof u.svipWealth !== "number") u.svipWealth = 0;
        if (typeof u.svipLevel !== "number") u.svipLevel = 0;
        if (u.svipMembershipType === undefined) u.svipMembershipType = "permanent"; // "permanent" | "timed"
        if (u.svipExpireAt === undefined) u.svipExpireAt = null; // ISO string, null = permanent/no membership
        if (u.svipExpiryWarned === undefined) u.svipExpiryWarned = false;
        // Admin-assigned SVIP tag override (Custom Tag Assignment). Independent
        // of the wealth-based svipLevel — lets Admin hand a specific level's PNG
        // tag to any User ID directly, regardless of that user's actual spend.
        if (u.assignedTagLevel === undefined) u.assignedTagLevel = null;
    }

    // The resource set actually shown to a given user: the normal cumulative
    // set for their computed svipLevel, but with the `tag` (and its cache-bust
    // version) swapped out for an Admin-assigned tag when one is set. This
    // keeps bubble/frame/entryEffect/etc. tied to real wealth level while the
    // *tag* can be manually granted independent of it.
    function resourcesForUser(u) {
        const base = resourcesForLevel(u.svipLevel || 0);
        const overrideLevel = u.assignedTagLevel;
        if (overrideLevel) {
            const key = "SVIP" + overrideLevel;
            if (resourceMap[key] && resourceMap[key].tag) {
                return Object.assign({}, base, { tag: resourceMap[key].tag, tagVersion: resourceMap[key].tagVersion });
            }
        }
        return base;
    }

    // GAP #1 — was socketsByUserId[userId]-gated (local-instance only);
    // now delegates to server.js's cross-instance-safe emitToUser()
    // (per-user Socket.IO room + Redis adapter) if injected, falling back
    // to the old local-socket path only if a caller/test doesn't supply it.
    function emitToUser(userId, event, payload) {
        if (typeof crossInstanceEmitToUser === "function") { crossInstanceEmitToUser(userId, event, payload); return; }
        const sid = socketsByUserId[userId];
        if (sid) io.to(sid).emit(event, payload);
    }

    function pushNotification(userId, type, message) {
        const n = { userId, type, message, time: new Date().toISOString(), read: false };
        notifications.push(n);
        saveNotifications();
        emitToUser(userId, "svip_notification", n);
        return n;
    }

    // ---- Wealth History (audit log) ----
    function logWealth(userId, diamondAmount, wealthAfter, referenceId, type) {
        wealthHistory.push({
            uid: userId,
            type: type || "wealth_added",
            diamond: diamondAmount,
            wealth: wealthAfter,
            date: new Date().toISOString(),
            referenceId: referenceId || null
        });
        saveWealthHistory();
    }

    // ---- Core: call whenever a user's SVIP-relevant spend happens ----
    // (e.g. sending a gift). Recalculates level server-side only — the
    // client never determines its own SVIP level (Developer Rule).
    function addWealth(userId, amount, referenceId, type) {
        if (!amount || amount <= 0) return null;
        const found = findUserByUserId(userId);
        if (!found) return null;
        const u = found.user;
        ensureUserSvipFields(u);

        const prevLevel = u.svipLevel;
        u.svipWealth += amount;
        logWealth(userId, amount, u.svipWealth, referenceId, type);

        const newLevel = levelFromWealth(u.svipWealth);
        if (newLevel !== prevLevel) {
            u.svipLevel = newLevel;
            svipHistory.push({ uid: userId, fromLevel: prevLevel, toLevel: newLevel, date: new Date().toISOString(), reason: newLevel > prevLevel ? "level_up" : "recalculated" });
            saveSvipHistory();
            if (newLevel > prevLevel) pushNotification(userId, "level_up", `Congratulations! You are now SVIP${newLevel}.`);
            const resources = resourcesForUser(u);
            emitToUser(userId, "svip_level_changed", { userId, fromLevel: prevLevel, toLevel: newLevel, resources });
            emitToUser(userId, "svip_resource_update", { userId, level: newLevel, resources });
            emitToUser(userId, "profile_frame_update", { userId, frame: resources.frame || null });
            emitToUser(userId, "bubble_update", { userId, bubble: resources.bubble || null });
            emitToUser(userId, "badge_update", { userId, badge: resources.badge || null });
        }

        saveUsers();
        emitToUser(userId, "wealth_update", { userId, svipWealth: u.svipWealth, svipLevel: u.svipLevel });
        pushNotification(userId, "wealth_added", `+${amount} wealth`);
        return { svipWealth: u.svipWealth, svipLevel: u.svipLevel, leveledUp: newLevel !== prevLevel };
    }

    // ---- Expiry System ----
    // Grants/renews a membership window. type "permanent" clears any expiry;
    // type "timed" with `days` sets svipExpireAt. Does not itself change
    // svipLevel/svipWealth — level still comes from wealth; this only gates
    // whether the *privilege resources* stay active (matches SRS: expiry
    // removes Frame/Bubble/Entry Effect/Badge and auto-downgrades).
    function grantMembership(userId, { type = "permanent", days = null } = {}) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const u = found.user;
        ensureUserSvipFields(u);
        u.svipMembershipType = type;
        u.svipExpireAt = type === "timed" && days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
        u.svipExpiryWarned = false;
        saveUsers();
        const resources = resourcesForUser(u);
        emitToUser(userId, "svip_resource_update", { userId, level: u.svipLevel, resources, expireAt: u.svipExpireAt });
        return u;
    }

    const EXPIRY_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

    // Checks one user's timed membership; auto-downgrades (removes all
    // resources by dropping svipLevel to 0) if expired, or fires an
    // "expiring soon" notification once inside the warning window.
    function checkExpiry(userId) {
        const found = findUserByUserId(userId);
        if (!found) return;
        const u = found.user;
        ensureUserSvipFields(u);
        if (u.svipMembershipType !== "timed" || !u.svipExpireAt) return;

        const msLeft = new Date(u.svipExpireAt).getTime() - Date.now();
        if (msLeft <= 0) {
            const prevLevel = u.svipLevel;
            u.svipLevel = 0;
            u.svipMembershipType = "permanent";
            u.svipExpireAt = null;
            u.svipExpiryWarned = false;
            saveUsers();
            svipHistory.push({ uid: userId, fromLevel: prevLevel, toLevel: 0, date: new Date().toISOString(), reason: "expired" });
            saveSvipHistory();
            pushNotification(userId, "membership_expired", "Your SVIP membership has expired.");
            const resourcesAfterExpiry = resourcesForUser(u);
            emitToUser(userId, "svip_level_changed", { userId, fromLevel: prevLevel, toLevel: 0, resources: resourcesAfterExpiry });
            emitToUser(userId, "svip_resource_update", { userId, level: 0, resources: resourcesAfterExpiry });
        } else if (msLeft <= EXPIRY_WARNING_WINDOW_MS && !u.svipExpiryWarned) {
            u.svipExpiryWarned = true;
            saveUsers();
            pushNotification(userId, "membership_expiring_soon", "Your SVIP membership is expiring soon.");
        }
    }

    // Call on every login / room-join so an active user always sees a
    // correct, up-to-date SVIP state without waiting for the periodic sweep.
    function onUserLoaded(u) {
        if (!u) return;
        ensureUserSvipFields(u);
        checkExpiry(u.userId);
    }

    // Periodic sweep — covers users who are offline (so their membership
    // still expires on schedule and downgrades even if they don't log in
    // exactly when it lapses).
    function sweepAllExpiries() {
        Object.values(users).forEach((u) => {
            if (u && u.userId) checkExpiry(u.userId);
        });
    }
    setInterval(sweepAllExpiries, 30 * 60 * 1000); // every 30 minutes

    function statusFor(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const u = found.user;
        ensureUserSvipFields(u);
        return {
            userId,
            svipWealth: u.svipWealth,
            svipLevel: u.svipLevel,
            membershipType: u.svipMembershipType,
            expireAt: u.svipExpireAt,
            resources: resourcesForUser(u),
            assignedTagLevel: u.assignedTagLevel || null
        };
    }

    // ---- SVIP Tag Assignment (Admin: give any uploaded level-tag to any User ID) ----
    // Independent of the wealth/level system — Admin picks a User ID and one of
    // the already-uploaded PNG tags (by level) from the Tag list, and it shows
    // on that user's profile immediately, in real time, and survives refresh/
    // re-login because it's stored on the user record.
    function assignTagToUser(userId, level) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const lvl = Number(level);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 8) return { error: "bad_level" };
        const key = "SVIP" + lvl;
        if (!resourceMap[key] || !resourceMap[key].tag) return { error: "no_tag" };
        const u = found.user;
        ensureUserSvipFields(u);
        u.assignedTagLevel = lvl;
        saveUsers();
        const resources = resourcesForUser(u);
        emitToUser(userId, "svip_resource_update", { userId, level: u.svipLevel, resources });
        return { userId, assignedTagLevel: lvl, tag: resourceMap[key].tag, tagVersion: resourceMap[key].tagVersion };
    }

    function removeAssignedTag(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const u = found.user;
        ensureUserSvipFields(u);
        u.assignedTagLevel = null;
        saveUsers();
        const resources = resourcesForUser(u);
        emitToUser(userId, "svip_resource_update", { userId, level: u.svipLevel, resources });
        return { userId, assignedTagLevel: null };
    }

    function getAssignedTag(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        ensureUserSvipFields(found.user);
        return { userId, assignedTagLevel: found.user.assignedTagLevel || null };
    }

    // ---- Anti-cheat: consistency check between wealth_history and the
    // live svipWealth field (should always match; a mismatch means the
    // field was changed some other way than addWealth()). ----
    function verifyWealthConsistency(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const sum = wealthHistory.filter((h) => h.uid === userId).reduce((s, h) => s + (h.diamond || 0), 0);
        const current = found.user.svipWealth || 0;
        return { userId, historySum: sum, currentWealth: current, matches: sum === current };
    }

    // ---- Leaderboard (daily/weekly/monthly/all-time), from wealth_history ----
    function getLeaderboard(period = "all", limit = 20) {
        const now = Date.now();
        const windowMs = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 30 * 24 * 60 * 60 * 1000, all: Infinity }[period] || Infinity;
        const totals = {};
        wealthHistory.forEach((h) => {
            if (now - new Date(h.date).getTime() > windowMs) return;
            totals[h.uid] = (totals[h.uid] || 0) + (h.diamond || 0);
        });
        return Object.entries(totals)
            .map(([userId, wealth]) => {
                const found = findUserByUserId(userId);
                return { userId, wealth, name: found ? found.user.name : userId, svipLevel: found ? found.user.svipLevel || 0 : 0 };
            })
            .sort((a, b) => b.wealth - a.wealth)
            .slice(0, limit);
    }

    // ---- Config/resource getters+setters (for the future admin panel phase) ----
    function getConfig() { return config; }
    function setLevels(newLevels) {
        config.levels = Object.assign({}, config.levels, newLevels);
        saveConfig();
        return config;
    }
    function getResourceMap() { return resourceMap; }
    function setResourceMap(newMap) {
        resourceMap = Object.assign({}, resourceMap, newMap);
        saveResources();
        return resourceMap;
    }

    // ---- SVIP Tag Management (PNG upload per level) ----
    // Called by the admin upload endpoint once a validated, resized PNG has
    // been written to disk. Stores the URL + a version stamp (for
    // cache-busting) inside the same cumulative resourceMap used by
    // resourcesForLevel(), so uploading a tag "just works" everywhere the
    // level's resources are already read from.
    function setTagAsset(level, urlPath) {
        const key = "SVIP" + level;
        resourceMap[key] = Object.assign({}, resourceMap[key], { tag: urlPath, tagVersion: Date.now() });
        saveResources();
        return resourceMap[key];
    }
    function clearTagAsset(level) {
        const key = "SVIP" + level;
        if (resourceMap[key]) {
            delete resourceMap[key].tag;
            delete resourceMap[key].tagVersion;
            saveResources();
        }
    }
    // Flat list for the admin Tag Management screen: one row per level.
    function listTags() {
        return LEVEL_ORDER.map((key, i) => ({
            level: i + 1,
            tag: (resourceMap[key] && resourceMap[key].tag) || null,
            tagVersion: (resourceMap[key] && resourceMap[key].tagVersion) || null
        }));
    }

    return {
        ensureUserSvipFields,
        onUserLoaded,
        addWealth,
        grantMembership,
        checkExpiry,
        sweepAllExpiries,
        statusFor,
        verifyWealthConsistency,
        getLeaderboard,
        getConfig,
        setLevels,
        getResourceMap,
        setResourceMap,
        levelFromWealth,
        resourcesForLevel,
        setTagAsset,
        clearTagAsset,
        listTags,
        assignTagToUser,
        removeAssignedTag,
        getAssignedTag
    };
}

module.exports = { initSvip };
