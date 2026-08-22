// ==================================================
// PHASE 6 — NAME EFFECTS APPROVAL WORKFLOW (item 8 of the dev sequence)
// ==================================================
// Built on approvalEngine.js. Existing instant endpoints
// (GET /api/admin/name-effects/styles, POST .../assign, POST .../remove,
// all gated by namefx:approve) are untouched — an Owner/anyone with
// namefx:approve can still assign a style directly. This adds a SEPARATE
// review-gated path: Admin proposes assigning one of the existing
// VIP_NAME_EFFECT_STYLES to a specific user; Country Manager reviews;
// Super Admin approves, and ONLY approval actually calls the same
// assignment logic as the existing instant endpoint.
//
// Scoped by the TARGET USER's country (not the submitting admin's) —
// same convention as Recharge/Withdraw — since this action changes that
// user's profile.
//
// "Preview" requirement: no file upload involved (styles are a fixed,
// pre-existing CSS-class allow-list already shipped in style.css), so the
// style key itself IS the preview — the admin panel can render the same
// CSS class client-side to show exactly what it will look like before
// approving. Nothing new to host/serve here.

const { createApprovalWorkflow } = require("./approvalEngine.js");

function initNameEffectsApproval(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        findUserByUserId, saveUsers, syncProfileToRoom,
        VIP_NAME_EFFECT_STYLES,
        io, socketsByUserId, emitToUser,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const engineDeps = { app, DATA_FOLDER, safeRead, safeWrite, rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent };

    // GAP #1 — was socketsByUserId[record.userId]-gated (local-instance
    // only, silently dropped for a user connected to a different cluster
    // instance); emitToUser() delivers cross-instance via the per-user
    // Socket.IO room + Redis adapter (see server.js's emitToUser() header).
    function notifyUser(record, event) {
        emitToUser(record.userId, "approval-notification", { domain: "namefx", requestId: record.requestId, status: record.status, event, style: record.style });
    }

    const namefx = createApprovalWorkflow({
        deps: engineDeps,
        domain: "namefx",
        fileName: "namefx_requests.json",
        basePath: "/api/admin/name-effects/requests",
        idPrefix: "nfq_",
        permissions: { view: "namefx:view", submit: "namefx:submit", review: "namefx:review", approve: "namefx:approve" },
        extraSearchFields: ["style"],
        validateSubmit(body) {
            const found = findUserByUserId(body.targetUserId);
            if (!found) return { ok: false, message: "Provide a valid Target User ID" };
            if (!VIP_NAME_EFFECT_STYLES.includes(body.style)) return { ok: false, message: "Select a valid VIP Style (from the preview list)" };
            return {
                ok: true,
                userId: body.targetUserId,
                countryId: found.user.countryId || "OTHERS",
                data: { domain: "namefx", style: body.style, targetUserName: found.user.name || null }
            };
        },
        onApprove(record) {
            const found = findUserByUserId(record.userId);
            if (!found) return { ok: false, message: "User no longer exists" };
            found.user.nameEffect = record.style;
            saveUsers();
            syncProfileToRoom(record.userId);
            emitToUser(record.userId, "name-effect-updated", found.user.nameEffect); // GAP #1 — cross-instance-safe, see notifyUser() above
            return { ok: true };
        },
        onNotify: notifyUser
    });

    return { namefx };
}

module.exports = { initNameEffectsApproval };
