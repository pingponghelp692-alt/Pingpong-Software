// ==================================================
// PHASE 6 — GIFTS APPROVAL WORKFLOW (item 10 of the dev sequence)
// ==================================================
// Built on approvalEngine.js. Existing instant endpoints
// (POST /api/admin/gifts/upload, POST /api/admin/video-gifts/upload,
// both gated by gifts:manage / video-gifts:manage, both handle real
// multipart file upload) are completely untouched. This adds a SEPARATE
// review-gated path for PROPOSING a new catalog item (Normal, Animated,
// or Video gift) before it goes live — a designer/Admin submits gift
// metadata + already-hosted preview asset URL(s); Country Manager
// reviews; Super Admin approves, and ONLY approval actually pushes the
// new entry into the live catalog (giftCatalog for Normal/Animated,
// videoGiftCatalog for Video) and broadcasts it to connected clients,
// exactly like the instant upload endpoints do.
//
// Honest scope note: this workflow does NOT handle multipart file
// upload itself (submit is a plain JSON body, like every other request
// in this approval system) — the preview image/video/thumbnail must
// already be hosted somewhere reachable (e.g. uploaded once through the
// existing instant endpoints' static folders, or external hosting) and
// its URL passed in the submit body. Re-implementing a second multipart
// upload pipeline just for the approval-preview stage was judged not
// worth the added surface area; if that's needed later it can be added
// as its own small multer route that only stores the file and returns a
// URL, without touching this workflow's logic.
//
// Scoped by the SUBMITTING ADMIN's own country (gifts aren't user-owned
// data, so there's no natural "whose country" the way Recharge/Withdraw/
// Name Effects/Frames have — the submitter's country is what a Country
// Manager's review queue should filter on).

const crypto = require("crypto");
const { createApprovalWorkflow } = require("./approvalEngine.js");

const NORMAL_TIERS = ["normal", "vip", "legend"];
const GIFT_TYPES = ["normal", "animated", "video"];

function initGiftsApproval(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        giftCatalog, saveGiftCatalog, broadcastGiftCatalog,
        videoGiftCatalog, saveVideoGiftCatalog, broadcastVideoGiftCatalog,
        MIN_VIDEO_GIFT_PRICE,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const engineDeps = { app, DATA_FOLDER, safeRead, safeWrite, rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent };

    const gifts = createApprovalWorkflow({
        deps: engineDeps,
        domain: "gifts",
        fileName: "gifts_requests.json",
        basePath: "/api/admin/gifts/requests",
        idPrefix: "gfq_",
        permissions: { view: "gifts:view", submit: "gifts:submit", review: "gifts:review", approve: "gifts:approve" },
        extraSearchFields: ["giftType", "category", "version"],
        validateSubmit(body, req) {
            const name = (body.name || "").trim();
            if (!name) return { ok: false, message: "Provide a Gift Name" };
            const giftType = GIFT_TYPES.includes(body.giftType) ? body.giftType : null;
            if (!giftType) return { ok: false, message: "Provide a Gift Type (normal/animated/video)" };
            const price = Number(body.price);
            const minPrice = giftType === "video" ? (MIN_VIDEO_GIFT_PRICE || 1) : 1;
            if (!Number.isFinite(price) || price < minPrice) return { ok: false, message: `Provide a valid Coin Price (minimum ${minPrice})` };
            if (giftType === "video" && !(body.videoUrl || "").trim()) return { ok: false, message: "Provide a Video URL (must already be hosted)" };
            if (giftType !== "video" && !(body.previewImageUrl || "").trim()) return { ok: false, message: "Provide a Preview Image URL (must already be hosted)" };
            const category = NORMAL_TIERS.includes(body.category) ? body.category : "normal";

            return {
                ok: true,
                userId: null,
                countryId: (req.adminAccount.countryId) || "OTHERS",
                data: {
                    domain: "gifts",
                    giftType, category,
                    version: (body.version || "1.0").toString().slice(0, 20),
                    price,
                    effectType: body.effectType === "full_screen" ? "full_screen" : "small",
                    duration: giftType === "video" ? Math.min(8, Math.max(6, Number(body.duration) || 6)) : null,
                    previewImageUrl: (body.previewImageUrl || "").trim() || null,
                    videoUrl: (body.videoUrl || "").trim() || null,
                    thumbnailUrl: (body.thumbnailUrl || "").trim() || null,
                    soundUrl: (body.soundUrl || "").trim() || null,
                    name
                }
            };
        },
        onApprove(record) {
            if (record.giftType === "video") {
                const gift = {
                    id: "vgift_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
                    name: record.name, price: record.price, duration: record.duration || 6,
                    videoUrl: record.videoUrl, thumbnail: record.thumbnailUrl || null,
                    enabled: true, createdAt: new Date().toISOString(), viaRequestId: record.requestId
                };
                videoGiftCatalog.push(gift);
                saveVideoGiftCatalog();
                broadcastVideoGiftCatalog();
                return { ok: true, extra: { publishedId: gift.id } };
            }
            const gift = {
                id: "gift_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
                name: record.name, price: record.price, effectType: record.effectType, tier: record.category,
                image: record.previewImageUrl, sound: record.soundUrl || null,
                animated: record.giftType === "animated",
                enabled: true, createdAt: new Date().toISOString(), viaRequestId: record.requestId
            };
            giftCatalog.push(gift);
            saveGiftCatalog();
            broadcastGiftCatalog();
            return { ok: true, extra: { publishedId: gift.id } };
        }
    });

    return { gifts };
}

module.exports = { initGiftsApproval };
