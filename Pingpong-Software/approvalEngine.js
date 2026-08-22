// ==================================================
// PHASE 6 — SHARED APPROVAL ENGINE
// ==================================================
// One generic state machine used by every approval domain (Recharge,
// Withdraw, Name Effects, Frames, Gifts, Diamond Seller, VIP), instead of
// each domain hand-rolling its own copy of the pending/review/approve/
// reject/reopen logic (which is how agencyApproval.js — Phase 6 item 1 —
// was originally written). Domain modules call createApprovalWorkflow(...)
// once and get back { requests, findRequest, saveRequests, snapshot } so
// they can add domain-specific endpoints (e.g. Diamond Seller's
// suspend/restore, VIP's expire/renew) on top of the same store.
//
// State machine (identical to Agency's, generalised):
//   pending -> review -> approved     (onApprove hook runs the real
//                                       side-effect: create record, credit
//                                       wallet, publish to catalog, etc.)
//   pending -> review -> rejected
//   pending -> rejected               (reviewer/approver may reject
//                                       straight out of "pending")
//   rejected -> pending               (reopen)
//   Owner may force ANY transition from ANY status (override).
//
// Every module gets, for free:
//   - Approval History / Timeline  -> record.history[]
//   - Reject Reason / Manual Notes -> record.decisionNote / reviewNote
//   - Comment System               -> POST :id/comment (no status change)
//   - Audit Log                    -> rbac.logAction on every transition
//   - Country Isolation            -> actorCanAccessCountry on every route
//   - Permission Check             -> requirePermission per step
//   - Owner Override               -> isOwner() bypass on status guards
//   - Search / Pagination / Filtering -> GET list route
//   - Notification hooks           -> optional onNotify(record, event)
//
// This file is additive and self-contained (same pattern as rbac.js /
// agencyHost.js) — it does not import or modify any other file.

const path = require("path");
const crypto = require("crypto");

function createApprovalWorkflow(config) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = config.deps;

    const {
        domain,               // e.g. "recharge" — used in action names / module tag
        fileName,             // e.g. "recharge_requests.json"
        basePath,             // e.g. "/api/admin/recharge/requests"
        idPrefix,             // e.g. "rcq_"
        permissions,          // { view, submit, review, approve }
        validateSubmit,       // (body, req) => { ok, message, data, countryId, userId }
        onApprove,            // (record, req) => { ok, message, extra } | undefined
        onNotify,             // optional (record, event) => void
        extraSearchFields = [] // extra top-level string fields to include in free-text search
    } = config;

    const STORE_FILE = path.join(DATA_FOLDER, fileName);
    let requests = safeRead(STORE_FILE, {});
    function saveRequests() { safeWrite(STORE_FILE, requests); }

    function isOwner(actor) { return actor && actor.role === rbac.ROLES.OWNER; }
    function snapshot(r) { return r ? Object.assign({}, r, { history: (r.history || []).slice() }) : null; }

    function pushHistory(record, entry) {
        if (!Array.isArray(record.history)) record.history = [];
        record.history.push(Object.assign({ at: new Date().toISOString() }, entry));
    }

    function logStep(req, action, record, before) {
        rbac.logAction({
            admin: req.adminAccount, action: domain + "-" + action, module: domain,
            targetType: domain + "-request", targetId: record.requestId,
            before: before || undefined, after: snapshot(record),
            ip: req.ip, userAgent: reqUserAgent(req)
        });
    }

    function notify(record, event) {
        if (typeof onNotify === "function") {
            try { onNotify(record, event); } catch (_) { /* notification failures never break the workflow */ }
        }
    }

    function deniedNoPermission(req, permsList) {
        rbac.logAction({
            admin: req.adminAccount, action: "authorization-denied", module: "security",
            targetType: "endpoint", targetId: req.originalUrl,
            meta: { method: req.method, permission: permsList.join(" or ") },
            ip: req.ip, userAgent: reqUserAgent(req),
            result: "failed", failureReason: "missing permission: " + permsList.join(" or ")
        });
    }

    function requireAnyPermission(permsList) {
        return function (req, res, next) {
            const acc = req.adminAccount;
            if (permsList.some((p) => rbac.hasPermission(acc, p))) return next();
            deniedNoPermission(req, permsList);
            return res.status(403).json({ success: false, message: "You don't have permission for this action" });
        };
    }

    // ==================================================
    // 1. LIST — search / filter / pagination
    // ==================================================
    app.get(basePath, requireAdmin, requirePermission(permissions.view), (req, res) => {
        let list = Object.values(requests).filter((r) => actorCanAccessCountry(req.adminAccount, r.countryId));
        if (req.query.status) list = list.filter((r) => r.status === req.query.status);
        if (req.query.countryId) list = list.filter((r) => r.countryId === req.query.countryId);
        if (req.query.userId) list = list.filter((r) => r.userId === req.query.userId);
        if (req.query.q) {
            const q = String(req.query.q).toLowerCase();
            const fields = ["requestId", "userId", "status"].concat(extraSearchFields);
            list = list.filter((r) => fields.some((f) => String(r[f] || "").toLowerCase().includes(q)));
        }
        list = list.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        const total = list.length;
        const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const start = (page - 1) * pageSize;
        res.json({ success: true, requests: list.slice(start, start + pageSize), total, page, pageSize });
    });

    // ==================================================
    // 2. SUBMIT
    // ==================================================
    app.post(basePath + "/submit", requireAdmin, requirePermission(permissions.submit), (req, res) => {
        const v = validateSubmit(req.body, req);
        if (!v.ok) return res.json({ success: false, message: v.message || "Provide valid information" });
        if (!actorCanAccessCountry(req.adminAccount, v.countryId)) return countryDeniedResponse(res);

        const requestId = idPrefix + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        const record = Object.assign({}, v.data, {
            requestId,
            userId: v.userId || null,
            countryId: v.countryId || "OTHERS",
            status: "pending",
            submittedBy: { id: req.adminAccount.id, username: req.adminAccount.username },
            submitNote: req.body.note || null,
            reviewedBy: null, reviewNote: null,
            decidedBy: null, decisionNote: null,
            history: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        pushHistory(record, { action: "submit", by: record.submittedBy, note: record.submitNote });
        requests[requestId] = record;
        saveRequests();
        logStep(req, "request-submit", record, null);
        notify(record, "submitted");
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 3. REVIEW — pending -> review. Owner: any status.
    // ==================================================
    app.post(basePath + "/:requestId/review", requireAdmin, requirePermission(permissions.review), (req, res) => {
        const record = requests[req.params.requestId];
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
        pushHistory(record, { action: "review", by: record.reviewedBy, note: record.reviewNote });
        saveRequests();
        logStep(req, "request-review", record, before);
        notify(record, "review");
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 4. APPROVE — pending/review -> approved. Runs onApprove side-effect.
    //    Owner: any status.
    // ==================================================
    app.post(basePath + "/:requestId/approve", requireAdmin, requirePermission(permissions.approve), (req, res) => {
        const record = requests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): the "Owner
        // may force ANY transition from ANY status" override above used to
        // apply to approve() with no exception — including a record whose
        // status was ALREADY "approved". onApprove() is where the real money
        // moves (credit coins, deduct diamonds, etc.), so a double-click,
        // retried network call, or replayed request against an
        // already-approved record re-ran that side effect a second time and
        // silently double-credited/double-debited the user — a genuine
        // double-spend, not just a cosmetic state-machine glitch. "Already
        // approved" is never a meaningful re-approve target for anyone,
        // Owner included, so this check is now absolute (no isOwner bypass).
        if (record.status === "approved") {
            return res.json({ success: false, message: "This request was already approved — its financial effect has already been applied and cannot be applied again." });
        }
        if (!["pending", "review"].includes(record.status) && !isOwner(req.adminAccount)) {
            return res.json({ success: false, message: "Only a 'pending' or 'review' request can be approved (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        let extra = {};
        if (typeof onApprove === "function") {
            const result = onApprove(record, req) || { ok: true };
            if (!result.ok) return res.json({ success: false, message: result.message || "Could not approve" });
            extra = result.extra || {};
        }
        record.status = "approved";
        record.decidedBy = { id: req.adminAccount.id, username: req.adminAccount.username };
        record.decisionNote = req.body.note || null;
        record.updatedAt = new Date().toISOString();
        Object.assign(record, extra);
        pushHistory(record, { action: "approve", by: record.decidedBy, note: record.decisionNote });
        saveRequests();
        logStep(req, "request-approve", record, before);
        notify(record, "approved");
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 5. REJECT — pending/review -> rejected. review or approve permission.
    //    Owner: any status.
    // ==================================================
    app.post(basePath + "/:requestId/reject", requireAdmin, requireAnyPermission([permissions.review, permissions.approve]), (req, res) => {
        const record = requests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        if (!["pending", "review"].includes(record.status) && !isOwner(req.adminAccount)) {
            return res.json({ success: false, message: "Only a 'pending' or 'review' request can be rejected (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        record.status = "rejected";
        record.decidedBy = { id: req.adminAccount.id, username: req.adminAccount.username };
        record.decisionNote = req.body.note || req.body.reason || null;
        record.updatedAt = new Date().toISOString();
        pushHistory(record, { action: "reject", by: record.decidedBy, note: record.decisionNote });
        saveRequests();
        logStep(req, "request-reject", record, before);
        notify(record, "rejected");
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 6. REOPEN — rejected -> pending. Any of submit/review/approve perm.
    //    Owner: any status.
    // ==================================================
    app.post(basePath + "/:requestId/reopen", requireAdmin, requireAnyPermission([permissions.submit, permissions.review, permissions.approve]), (req, res) => {
        const record = requests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): reopen was
        // documented as "rejected -> pending" only, but the blanket Owner
        // override let it run from ANY status, including "approved". Reopening
        // an approved request resets it to "pending" while leaving the money
        // it already moved in place — and a "pending" record needs no Owner
        // privilege to approve, so any admin with normal approve permission
        // could then trigger onApprove() again and double-credit/double-debit
        // the user. Reopen from "approved" is blocked for everyone, Owner
        // included, since the documented state machine never intended it and
        // there is no safe way to undo a financial side effect that already
        // ran. (Reopening a rejected request, which never ran onApprove,
        // remains fully unaffected — including for non-Owner staff.)
        if (record.status === "approved") {
            return res.json({ success: false, message: "An approved request's financial effect has already been applied and cannot be reopened. Submit a new request instead." });
        }
        if (record.status !== "rejected" && !isOwner(req.adminAccount)) {
            return res.json({ success: false, message: "Only a 'rejected' request can be reopened (current status: " + record.status + ")" });
        }
        const before = snapshot(record);
        const reopenedBy = { id: req.adminAccount.id, username: req.adminAccount.username };
        record.status = "pending";
        record.reviewedBy = null; record.reviewNote = null;
        record.decidedBy = null; record.decisionNote = null;
        record.reopenedBy = reopenedBy;
        record.updatedAt = new Date().toISOString();
        pushHistory(record, { action: "reopen", by: reopenedBy, note: req.body.note || null });
        saveRequests();
        logStep(req, "request-reopen", record, before);
        notify(record, "reopened");
        res.json({ success: true, request: record });
    });

    // ==================================================
    // 7. COMMENT — no status change, just adds to the timeline. Any of
    //    submit/review/approve permission (i.e. anyone who can act on the
    //    request at some stage can also leave a note on it).
    // ==================================================
    app.post(basePath + "/:requestId/comment", requireAdmin, requireAnyPermission([permissions.submit, permissions.review, permissions.approve]), (req, res) => {
        const record = requests[req.params.requestId];
        if (!record) return res.json({ success: false, message: "Request not found" });
        if (!actorCanAccessCountry(req.adminAccount, record.countryId)) return countryDeniedResponse(res);
        const text = (req.body.text || "").trim();
        if (!text) return res.json({ success: false, message: "Provide comment text" });
        const by = { id: req.adminAccount.id, username: req.adminAccount.username };
        pushHistory(record, { action: "comment", by, note: text.slice(0, 500) });
        record.updatedAt = new Date().toISOString();
        saveRequests();
        logStep(req, "request-comment", record, null);
        res.json({ success: true, request: record });
    });

    return { requests, saveRequests, snapshot, pushHistory, isOwner, requireAnyPermission };
}

module.exports = { createApprovalWorkflow };
