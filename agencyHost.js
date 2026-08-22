// ==================================================
// PHASE 3 — AGENCY & HOST SYSTEM
// ==================================================
// Additive module, same pattern as svip.js / coinCenter.js: server.js hands
// this its live in-memory state (users, rooms, agencies, sockets) and a few
// helper functions, and this file only ever reads that state or appends to
// it through the functions it was given (saveUsers, saveAgencies, ...). It
// never touches Wallet, Login, Session, Room, or core Gift logic.
//
// Gift History reuse: this module builds ONE extra in-memory index —
// giftHistoryByHost — from the existing `giftHistory` array server.js
// already maintains. It does not create a second gift-tracking table and
// does not write to gift_history.json itself; recordGiftHistory() in
// server.js remains the only writer. New gifts reach this module through
// registerGiftRecordedHook(), which server.js calls once per successful
// gift, right after it's already been written to gift_history.json.
//
// Gift Tracking Rule (mandatory, see README/spec): a gift only counts
// toward a host/agency if entry.hostId === that host's userId. Since
// server.js already sets hostId to `rooms[roomId].hostId` (the room's
// owner) at the moment the gift is recorded — not to whoever the gift was
// visually aimed at — a host only ever accumulates gifts sent while inside
// their OWN room. If that same person joins someone else's room, gifts
// sent there carry that other room's hostId instead, so they never count
// here. No extra filtering logic was needed for this rule; it falls out of
// how Gift History was already being recorded.

const path = require("path");
const crypto = require("crypto");

function initAgencyHost(deps) {
    const {
        app, io, DATA_FOLDER, safeRead, safeWrite,
        users, findUserByUserId, saveUsers,
        agencies, saveAgencies,
        rooms, socketsByUserId, emitToUser,
        giftHistory, registerGiftRecordedHook, periodStart,
        privateMessages, saveMessages, conversationKey,
        INSTANT_EXCHANGE_RATE
    } = deps;

    // ---------- Agency Invites (separate small store; PM messages just
    // carry a pointer (inviteId) to a record here, same pattern gift
    // history uses roomId as a pointer rather than duplicating room data) ----------
    const AGENCY_INVITES_FILE = path.join(DATA_FOLDER, "agency_invites.json");
    let agencyInvites = safeRead(AGENCY_INVITES_FILE, {});
    function saveAgencyInvites() { safeWrite(AGENCY_INVITES_FILE, agencyInvites); }

    // ---------- Gift History index, by host ----------
    // Built once from the existing giftHistory array (no duplicate file),
    // kept in sync afterwards via the onGiftRecorded hook.
    const giftHistoryByHost = {};
    giftHistory.forEach((entry) => {
        if (!entry.hostId) return;
        (giftHistoryByHost[entry.hostId] = giftHistoryByHost[entry.hostId] || []).push(entry);
    });

    function computeStats(entries) {
        const dSince = periodStart("daily"), wSince = periodStart("weekly"), mSince = periodStart("monthly");
        const daily = { count: 0, diamonds: 0 }, weekly = { count: 0, diamonds: 0 };
        const monthly = { count: 0, diamonds: 0 }, total = { count: 0, diamonds: 0 };
        entries.forEach((e) => {
            const t = new Date(e.timestamp).getTime();
            total.count++; total.diamonds += e.diamondAmount;
            if (t >= mSince) { monthly.count++; monthly.diamonds += e.diamondAmount; }
            if (t >= wSince) { weekly.count++; weekly.diamonds += e.diamondAmount; }
            if (t >= dSince) { daily.count++; daily.diamonds += e.diamondAmount; }
        });
        return { daily, weekly, monthly, total };
    }
    function statsPayload(entries) {
        const s = computeStats(entries);
        return {
            dailyGifts: s.daily.count, dailyDiamonds: s.daily.diamonds,
            weeklyGifts: s.weekly.count, weeklyDiamonds: s.weekly.diamonds,
            monthlyGifts: s.monthly.count, monthlyDiamonds: s.monthly.diamonds,
            totalGifts: s.total.count, totalDiamonds: s.total.diamonds,
            estimatedCoinValue: Math.floor(s.total.diamonds * INSTANT_EXCHANGE_RATE)
        };
    }
    function giftDetail(entry) {
        const senderFound = findUserByUserId(entry.senderId);
        const room = rooms[entry.roomId];
        return {
            senderAvatar: senderFound ? (senderFound.user.photo || "") : "",
            senderName: senderFound ? senderFound.user.name : "User",
            senderUserId: entry.senderId,
            giftName: entry.giftName,
            diamondAmount: entry.diamondAmount,
            time: entry.timestamp,
            roomNumber: room ? (room.roomNumber || room.hostId) : (entry.roomId || "")
        };
    }

    // ==================================================
    // 1. AGENCY INVITE SYSTEM (via Private Messages)
    // ==================================================
    app.post("/api/agency/invite", (req, res) => {
        const { agencyId, fromUserId, toUserId } = req.body;
        const agency = agencies[agencyId];
        if (!agency || agency.ownerUserId !== fromUserId) {
            return res.json({ success: false, message: "Only the Agency Owner can send invites" });
        }
        const target = findUserByUserId(toUserId);
        if (!target) return res.json({ success: false, message: "User not found" });
        if (agency.hostIds.includes(toUserId)) return res.json({ success: false, message: "They are already a Host of this Agency" });

        const inviteId = "inv_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        agencyInvites[inviteId] = {
            inviteId, agencyId, fromUserId, toUserId,
            status: "pending", createdAt: new Date().toISOString()
        };
        saveAgencyInvites();

        const key = conversationKey(fromUserId, toUserId);
        if (!privateMessages[key]) privateMessages[key] = [];
        const msg = {
            from: fromUserId, to: toUserId,
            message: `Agency invitation: ${agency.name}`,
            time: new Date().toISOString(),
            type: "agency_invite",
            data: { inviteId, agencyId, agencyName: agency.name, agencyLogo: agency.logo || null, agencyIdDisplay: agencyId, status: "pending" }
        };
        privateMessages[key].push(msg);
        saveMessages();
        emitToUser(toUserId, "new-private-message", msg); // GAP #1 — cross-instance-safe
        res.json({ success: true, message: msg });
    });

    app.post("/api/agency/invite/respond", (req, res) => {
        const { inviteId, userId, action } = req.body;
        const invite = agencyInvites[inviteId];
        if (!invite || invite.toUserId !== userId || invite.status !== "pending") {
            return res.json({ success: false, message: "This invitation is no longer active" });
        }
        const agency = agencies[invite.agencyId];
        if (!agency) return res.json({ success: false, message: "Agency not found" });

        const key = conversationKey(invite.fromUserId, invite.toUserId);
        const thread = privateMessages[key] || [];
        const msgIdx = thread.findIndex((m) => m.data && m.data.inviteId === inviteId);

        if (action === "accept") {
            const found = findUserByUserId(userId);
            if (!found) return res.json({ success: false, message: "User not found" });
            found.user.isHost = true;
            found.user.agencyId = invite.agencyId;
            if (!agency.hostIds.includes(userId)) agency.hostIds.push(userId);
            saveUsers(); saveAgencies();
            invite.status = "accepted"; saveAgencyInvites();
            if (msgIdx !== -1) { thread[msgIdx].data.status = "accepted"; saveMessages(); }

            // GAP #1 — cross-instance-safe via emitToUser()
            emitToUser(userId, "host-status-update", { isHost: true, agencyId: agency.agencyId });
            emitToUser(invite.fromUserId, "agency-host-list-update", { agencyId: agency.agencyId });
            return res.json({ success: true, status: "accepted" });
        }

        if (action === "decline") {
            invite.status = "declined"; saveAgencyInvites();
            // Spec: "Decline → Invitation is removed" — remove the card
            // from the shared thread rather than just marking it declined.
            if (msgIdx !== -1) { thread.splice(msgIdx, 1); saveMessages(); }
            emitToUser(invite.fromUserId, "agency-invite-updated", { inviteId, status: "declined" }); // GAP #1 — cross-instance-safe
            return res.json({ success: true, status: "declined" });
        }

        res.json({ success: false, message: "Unknown action" });
    });

    // Agency Owner sets/updates their own agency's logo. Reuses the
    // already-uploaded file URL from the existing generic
    // /api/room/logo/upload endpoint — no new upload handler needed.
    app.post("/api/agency/logo", (req, res) => {
        const { agencyId, ownerUserId, logoUrl } = req.body;
        const agency = agencies[agencyId];
        if (!agency || agency.ownerUserId !== ownerUserId) return res.json({ success: false, message: "Permission denied" });
        agency.logo = logoUrl || null;
        saveAgencies();
        res.json({ success: true, agency });
    });

    // ==================================================
    // 2. HOST CENTER
    // ==================================================
    app.get("/api/host-center/:userId", (req, res) => {
        const found = findUserByUserId(req.params.userId);
        if (!found) return res.json({ success: false, message: "User not found" });
        if (!found.user.agencyId) return res.json({ success: false, message: "You are not a Host of any Agency yet" });
        const entries = giftHistoryByHost[req.params.userId] || [];
        res.json({ success: true, stats: statsPayload(entries) });
    });

    app.get("/api/host-center/:userId/gifts", (req, res) => {
        const found = findUserByUserId(req.params.userId);
        if (!found || !found.user.agencyId) return res.json({ success: false, message: "Permission denied" });
        const period = req.query.period || "all"; // daily | weekly | monthly | all
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        let entries = (giftHistoryByHost[req.params.userId] || []).slice().reverse();
        if (period !== "all") {
            const since = periodStart(period);
            entries = entries.filter((e) => new Date(e.timestamp).getTime() >= since);
        }
        res.json({ success: true, gifts: entries.slice(0, limit).map(giftDetail) });
    });

    // ==================================================
    // 3. AGENCY CENTER DASHBOARD
    // ==================================================
    app.get("/api/agency/dashboard/:agencyId", (req, res) => {
        const agency = agencies[req.params.agencyId];
        if (!agency) return res.json({ success: false, message: "Agency not found" });
        if (req.query.ownerUserId && agency.ownerUserId !== req.query.ownerUserId) {
            return res.json({ success: false, message: "Permission denied" });
        }
        let activeHosts = 0, dailyGifts = 0, weeklyGifts = 0, monthlyGifts = 0, totalDiamonds = 0;
        const hosts = agency.hostIds.map((hid) => {
            const hf = findUserByUserId(hid);
            // Belt-and-braces re-filter by agencyId too, in case a host was
            // ever moved between agencies — hostId alone already guarantees
            // "their own room only" per the tracking rule above.
            const entries = (giftHistoryByHost[hid] || []).filter((e) => e.agencyId === agency.agencyId);
            const s = computeStats(entries);
            const online = !!socketsByUserId[hid];
            if (online) activeHosts++;
            dailyGifts += s.daily.count; weeklyGifts += s.weekly.count; monthlyGifts += s.monthly.count;
            totalDiamonds += s.total.diamonds;
            return {
                userId: hid, name: hf ? hf.user.name : "User", photo: hf ? (hf.user.photo || "") : "", online,
                dailyGifts: s.daily.count, dailyDiamonds: s.daily.diamonds,
                weeklyGifts: s.weekly.count, weeklyDiamonds: s.weekly.diamonds,
                monthlyGifts: s.monthly.count, monthlyDiamonds: s.monthly.diamonds,
                totalGifts: s.total.count, totalDiamonds: s.total.diamonds
            };
        });
        res.json({
            success: true,
            agency: { agencyId: agency.agencyId, name: agency.name, logo: agency.logo || null, commissionRate: agency.commissionRate, earnedDiamonds: agency.earnedDiamonds || 0 },
            totals: { totalHosts: agency.hostIds.length, activeHosts, dailyGifts, weeklyGifts, monthlyGifts, totalDiamonds },
            hosts
        });
    });

    // ==================================================
    // 5. AGENCY <-> HOST SYNCHRONIZATION (live push)
    // ==================================================
    // Fires once per successful gift, after server.js has already written
    // it to gift_history.json — this only reads that same record.
    registerGiftRecordedHook((record) => {
        if (!record.hostId) return;
        (giftHistoryByHost[record.hostId] = giftHistoryByHost[record.hostId] || []).push(record);

        // GAP #1 — cross-instance-safe via emitToUser() (was socketsByUserId-gated, local-instance only)
        emitToUser(record.hostId, "host-stats-update", statsPayload(giftHistoryByHost[record.hostId]));
        emitToUser(record.hostId, "host-gift-received", giftDetail(record));
        if (record.agencyId) {
            const agency = agencies[record.agencyId];
            if (agency) emitToUser(agency.ownerUserId, "agency-stats-update", { agencyId: agency.agencyId });
        }
    });

    return {};
}

module.exports = { initAgencyHost };
