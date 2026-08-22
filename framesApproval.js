// ==================================================
// PHASE 6 — FRAMES APPROVAL WORKFLOW (item 9 of the dev sequence)
// ==================================================
// Built on approvalEngine.js. Existing instant endpoints
// (POST /api/admin/frames/send, POST /api/admin/frames/upload, both
// gated by frames:manage) are untouched. This adds a SEPARATE
// review-gated path for the SEND action specifically: Admin proposes
// giving an existing catalog frame (already uploaded via the instant
// /upload endpoint — frame catalog management itself isn't part of this
// approval flow, only assigning one to a user) to a specific user for N
// days; Country Manager reviews; Super Admin approves, and ONLY approval
// actually calls the same assignment logic as the existing /frames/send
// endpoint.
//
// Scoped by the TARGET USER's country, same convention as Recharge/
// Withdraw/Name Effects.
//
// "Preview" requirement: the requested frame's existing imageUrl (already
// hosted from the prior /frames/upload call) is returned as part of the
// request record — the admin panel can render it directly, no new asset
// handling needed here.

const { createApprovalWorkflow } = require("./approvalEngine.js");

function initFramesApproval(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        findUserByUserId, saveUsers, syncProfileToRoom,
        frameCatalog,
        io, socketsByUserId, emitToUser,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const engineDeps = { app, DATA_FOLDER, safeRead, safeWrite, rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent };

    // GAP #1 — cross-instance-safe, see server.js's emitToUser() header
    function notifyUser(record, event) {
        emitToUser(record.userId, "approval-notification", { domain: "frames", requestId: record.requestId, status: record.status, event, frameId: record.frameId });
    }

    const frames = createApprovalWorkflow({
        deps: engineDeps,
        domain: "frames",
        fileName: "frames_requests.json",
        basePath: "/api/admin/frames/requests",
        idPrefix: "frq_",
        permissions: { view: "frames:view", submit: "frames:submit", review: "frames:review", approve: "frames:approve" },
        extraSearchFields: ["frameId"],
        validateSubmit(body) {
            const found = findUserByUserId(body.targetUserId);
            if (!found) return { ok: false, message: "Provide a valid Target User ID" };
            const frame = frameCatalog.find((f) => f.id === body.frameId);
            if (!frame) return { ok: false, message: "Frame not found (must first be added to the catalog via /frames/upload)" };
            const expiryDays = body.expiryDays ? Number(body.expiryDays) : null;
            return {
                ok: true,
                userId: body.targetUserId,
                countryId: found.user.countryId || "OTHERS",
                data: {
                    domain: "frames", frameId: frame.id, frameName: frame.name, previewImageUrl: frame.imageUrl,
                    expiryDays: Number.isFinite(expiryDays) ? expiryDays : null, targetUserName: found.user.name || null
                }
            };
        },
        onApprove(record) {
            const found = findUserByUserId(record.userId);
            if (!found) return { ok: false, message: "User no longer exists" };
            const frame = frameCatalog.find((f) => f.id === record.frameId);
            if (!frame) return { ok: false, message: "Frame is no longer in the catalog" };
            const user = found.user;
            if (!Array.isArray(user.frameInventory)) user.frameInventory = [];
            const isPermanent = !record.expiryDays;
            const expiresAt = isPermanent ? null : new Date(Date.now() + record.expiryDays * 86400000).toISOString();
            // Grants ownership only — mirrors the instant /api/admin/frames/send
            // endpoint. Does NOT auto-equip; the recipient selects it themselves
            // from My Frames, same as every other Frame/Vehicle assignment path.
            const existingIdx = user.frameInventory.findIndex((e) => e.frameId === frame.id);
            const entry = { frameId: frame.id, assignedAt: new Date().toISOString(), expiresAt, permanent: isPermanent, assignedBy: null };
            if (existingIdx >= 0) user.frameInventory[existingIdx] = entry; else user.frameInventory.push(entry);
            saveUsers();
            // Private to the recipient ONLY — never a global/broadcast emit.
            // GAP #1 — cross-instance-safe via emitToUser()
            emitToUser(record.userId, "frame-inventory-updated", { frameId: frame.id, frameName: frame.name });
            return { ok: true };
        },
        onNotify: notifyUser
    });

    return { frames };
}

module.exports = { initFramesApproval };
