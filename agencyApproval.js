// ==================================================
// PHASE 6 — AGENCY APPROVAL WORKFLOW (item 1 of Phase 6)
// ==================================================
// Additive module, same pattern as agencyHost.js: server.js hands this its
// live in-memory state and helper functions; this file only ever reads
// that state or appends to it through what it was given. It does NOT
// touch or replace the existing instant /api/admin/agency/create or
// /api/admin/agency/assign-host endpoints in server.js — those keep
// working exactly as before (an Owner/anyone with agencies:manage can
// still create an agency directly). This module adds a SEPARATE,
// parallel "request" flow on top, per the Phase 6 roadmap:
//
//   Admin          -> Submit   (agencies:submit)
//   Country Manager-> Review   (agencies:review)
//   Super Admin    -> Approve  (agencies:approve)   [Global/Country Super
//                                                     Admin already hold
//                                                     this permission via
//                                                     ALL_EXCEPT_OWNER_ONLY]
//   Owner          -> Override (implicit: Owner has every permission and
//                                bypasses country-scope AND the normal
//                                state-machine order — see isOwner below)
//
// State machine (per request, stored in agency_requests.json):
//   pending -> review -> approved   (creates the real Agency record)
//   pending -> review -> rejected
//   pending -> rejected             (Country Manager/Super Admin can also
//                                    reject straight out of "pending",
//                                    without a separate review step)
//   rejected -> pending             (Reopen)
//   Owner may force ANY transition from ANY status (override).
//
// Every transition is written to the audit log via rbac.logAction with
// before/after snapshots of the request — same pattern as every other
// mutating endpoint in this codebase (Phase 4/5).

const path = require("path");
const crypto = require("crypto");

function initAgencyApproval(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        users, findUserByUserId, saveUsers,
        agencies, saveAgencies,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const REQUESTS_FILE = path.join(DATA_FOLDER, "agency_requests.json");
    let agencyRequests = safeRead(REQUESTS_FILE, {});
    function saveAgencyRequests() { safeWrite(REQUESTS_FILE, agencyRequests); }

    function isOwner(actor) { return actor && actor.role === rbac.ROLES.OWNER; }

    // Small snapshot helper for before/after audit fields — never the raw
    // live object reference (that would show the SAME object for before
    // and after once mutated), so this always shallow-copies.
    function snapshot(reqObj) { return reqObj ? Object.assign({}, reqObj) : null; }

    // ==================================================
    // 1. LIST — Admin/Country Manager/Super Admin/Owner (agencies:view,
    //    same permission already gating the existing agency list endpoint)
    // ==================================================
    app.get("/api/admin/agency/requests", requireAdmin, requirePermission("agencies:view"), (req, res) => {
        let list = Object.values(agencyRequests).filter((r) => actorCanAccessCountry(req.adminAccount, r.countryId));
        if (req.query.status) list = list.filter((r) => r.status === req.query.status);
        list = list.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        res.json({ success: true, requests: list });
    });

    // ==================================================
    // 2. SUBMIT — Admin (agencies:submit). Creates a pending request; does
    //    NOT touch the `agencies` store yet — nothing is a real agency
    //    until it's approved.
    // ==================================================
    app.post("/api/admin/agency/requests/submit", requireAdmin, requirePermission("agencies:submit"), (req, res) => {
        const { name, ownerUserId, commissionRate, note } = req.body;
        const found = findUserByUserId(ownerUserId);
        if (!name || !found) return res.json({ success: false, message: "Provide a name and a valid Owner ID" });
        if (!actorCanAccessCountry(req.adminAccount, found.user.countryId)) return countryDeniedResponse(res);

        const requestId = "agreq_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        const record = {
            requestId, name, ownerUserId,
            commissionRate: commissionRate ? Number(commissionRate) : 0.3,
            countryId: found.user.countryId || "OTHERS",
            status: "pending",
            submittedBy: { id: req.adminAccount.id, username: req.adminAccount.username },
            submitNote: note || null,
            reviewedBy: null, reviewNote: null,
            decidedBy: null, decisionNote: null,
            agencyId: null, // filled in once approved
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        agencyRequests[requestId] = record;
        saveAgencyRequests();
        rbac.logAction({ admin: req.adminAccount, action: "agency-request-submit", module: "agency", targetType: "agency-request", targetId: requestId, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 3. REVIEW — Country Manager (agencies:review). pending -> review.
    //    Owner may review from any status.
    // ==================================================
    app.post("/api/admin/agency/requests/:requestId/review", requireAdmin, requirePermission("agencies:review"), (req, res) => {
        const record = agencyRequests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        if (record.status !== "pending" && !isOwner(req.adminAccount)) {
            return res.json({ success: false, message: "Only a 'pending' request can be reviewed (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        record.status = "review";
        record.reviewedBy = { id: req.adminAccount.id, username: req.adminAccount.username };
        record.reviewNote = req.body.note || null;
        record.updatedAt = new Date().toISOString();
        saveAgencyRequests();
        rbac.logAction({ admin: req.adminAccount, action: "agency-request-review", module: "agency", targetType: "agency-request", targetId: record.requestId, before, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 4. APPROVE — Super Admin (agencies:approve). pending/review ->
    //    approved, and THIS is where the real Agency record gets created
    //    (same shape as the existing instant /api/admin/agency/create).
    //    Owner may approve from any status.
    // ==================================================
    app.post("/api/admin/agency/requests/:requestId/approve", requireAdmin, requirePermission("agencies:approve"), (req, res) => {
        const record = agencyRequests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        if (!["pending", "review"].includes(record.status) && !isOwner(req.adminAccount)) {
            return res.json({ success: false, message: "Only a 'pending' or 'review' request can be approved (current status: " + record.status + ")" });
        }
        const found = findUserByUserId(record.ownerUserId);
        if (!found) return res.json({ success: false, message: "Owner user no longer exists" });

        const before = snapshot(record);
        const agencyId = "ag_" + crypto.randomBytes(4).toString("hex");
        agencies[agencyId] = {
            agencyId, name: record.name, ownerUserId: record.ownerUserId, hostIds: [],
            commissionRate: record.commissionRate, earnedDiamonds: 0, countryId: found.user.countryId
        };
        found.user.agencyId = agencyId;
        saveUsers();
        saveAgencies();

        record.status = "approved";
        record.decidedBy = { id: req.adminAccount.id, username: req.adminAccount.username };
        record.decisionNote = req.body.note || null;
        record.agencyId = agencyId;
        record.updatedAt = new Date().toISOString();
        saveAgencyRequests();

        rbac.logAction({ admin: req.adminAccount, action: "agency-request-approve", module: "agency", targetType: "agency-request", targetId: record.requestId, before, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
        rbac.logAction({ admin: req.adminAccount, action: "agency-create", module: "agency", targetType: "agency", targetId: agencyId, after: agencies[agencyId], meta: { viaRequestId: record.requestId }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, request: record, agency: agencies[agencyId] });
    });

    // ==================================================
    // 5. REJECT — Country Manager (during review) or Super Admin (final
    //    decision) — both hold either agencies:review or agencies:approve,
    //    so this route accepts either permission rather than one fixed
    //    gate. pending/review -> rejected. Owner may reject from any status.
    // ==================================================
    app.post("/api/admin/agency/requests/:requestId/reject", requireAdmin, (req, res) => {
        const acc = req.adminAccount;
        if (!rbac.hasPermission(acc, "agencies:review") && !rbac.hasPermission(acc, "agencies:approve")) {
            rbac.logAction({
                admin: acc, action: "authorization-denied", module: "security",
                targetType: "endpoint", targetId: req.originalUrl,
                meta: { method: req.method, permission: "agencies:review or agencies:approve" },
                ip: req.ip, userAgent: reqUserAgent(req),
                result: "failed", failureReason: "missing permission: agencies:review or agencies:approve"
            });
            return res.status(403).json({ success: false, message: "You don't have permission for this action" });
        }
        const record = agencyRequests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(acc, record.countryId)) return countryDeniedResponse(res);
        if (!["pending", "review"].includes(record.status) && !isOwner(acc)) {
            return res.json({ success: false, message: "Only a 'pending' or 'review' request can be rejected (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        record.status = "rejected";
        record.decidedBy = { id: acc.id, username: acc.username };
        record.decisionNote = req.body.note || req.body.reason || null;
        record.updatedAt = new Date().toISOString();
        saveAgencyRequests();
        rbac.logAction({ admin: acc, action: "agency-request-reject", module: "agency", targetType: "agency-request", targetId: record.requestId, before, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 6. REOPEN — same permission set as reject (whoever can review/
    //    approve can also send a rejected request back for another look).
    //    rejected -> pending. Owner may reopen from any status.
    // ==================================================
    app.post("/api/admin/agency/requests/:requestId/reopen", requireAdmin, (req, res) => {
        const acc = req.adminAccount;
        if (!rbac.hasPermission(acc, "agencies:submit") && !rbac.hasPermission(acc, "agencies:review") && !rbac.hasPermission(acc, "agencies:approve")) {
            rbac.logAction({
                admin: acc, action: "authorization-denied", module: "security",
                targetType: "endpoint", targetId: req.originalUrl,
                meta: { method: req.method, permission: "agencies:submit or agencies:review or agencies:approve" },
                ip: req.ip, userAgent: reqUserAgent(req),
                result: "failed", failureReason: "missing permission: agencies:submit or agencies:review or agencies:approve"
            });
            return res.status(403).json({ success: false, message: "You don't have permission for this action" });
        }
        const record = agencyRequests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(acc, record.countryId)) return countryDeniedResponse(res);
        if (record.status !== "rejected" && !isOwner(acc)) {
            return res.json({ success: false, message: "Only a 'rejected' request can be reopened (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        record.status = "pending";
        record.reviewedBy = null; record.reviewNote = null;
        record.decidedBy = null; record.decisionNote = null;
        record.reopenedBy = { id: acc.id, username: acc.username };
        record.updatedAt = new Date().toISOString();
        saveAgencyRequests();
        rbac.logAction({ admin: acc, action: "agency-request-reopen", module: "agency", targetType: "agency-request", targetId: record.requestId, before, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, request: record });
    });

    return {};
}

module.exports = { initAgencyApproval };
