// ==================================================
// Home Banner System — Backend Core (additive module)
// ==================================================
// Self-contained, like coinCenter.js/svip.js — does not modify any existing
// wallet/room/user logic. server.js wires this in by calling
// initBannerManagement({ DATA_FOLDER, safeRead, safeWrite }) once and
// exposing a few new /api/banners + /api/admin/banners routes.
//
// Schema (data/banners.json — array of):
//   { _id, imageUrl, linkUrl, isActive, order, createdAt }

const crypto = require("crypto");
const path = require("path");

function initBannerManagement({ DATA_FOLDER, safeRead, safeWrite }) {
    const STATE_FILE = path.join(DATA_FOLDER, "banners.json");

    let banners = safeRead(STATE_FILE, []);
    if (!Array.isArray(banners)) banners = [];
    // Backfill in case of an older/partial state file.
    banners.forEach((b, i) => {
        if (typeof b.isActive !== "boolean") b.isActive = true;
        if (typeof b.order !== "number") b.order = i;
        if (typeof b.linkUrl !== "string") b.linkUrl = b.linkUrl || "";
    });
    save();

    function save() {
        safeWrite(STATE_FILE, banners);
    }

    function sortedByOrder(list) {
        return list.slice().sort((a, b) => a.order - b.order);
    }

    // Public: what the Home page banner slider fetches — active banners only.
    function listActive() {
        return sortedByOrder(banners.filter((b) => b.isActive));
    }

    // Admin: full list (active + inactive) for the Banner Management panel.
    function listAll() {
        return sortedByOrder(banners);
    }

    function create({ imageUrl, linkUrl }) {
        const nextOrder = banners.length ? Math.max(...banners.map((b) => b.order)) + 1 : 0;
        const banner = {
            _id: crypto.randomBytes(8).toString("hex"),
            imageUrl,
            linkUrl: (linkUrl || "").toString().trim().slice(0, 500),
            isActive: true,
            order: nextOrder,
            createdAt: new Date().toISOString()
        };
        banners.push(banner);
        save();
        return banner;
    }

    function remove(id) {
        const idx = banners.findIndex((b) => b._id === id);
        if (idx === -1) return null;
        const [removed] = banners.splice(idx, 1);
        save();
        return removed;
    }

    function toggle(id) {
        const banner = banners.find((b) => b._id === id);
        if (!banner) return null;
        banner.isActive = !banner.isActive;
        save();
        return banner;
    }

    // Drag & drop reorder from the Admin Panel — `orderedIds` is the full
    // list of banner ids in their new display order.
    function reorder(orderedIds) {
        if (!Array.isArray(orderedIds)) return false;
        orderedIds.forEach((id, i) => {
            const banner = banners.find((b) => b._id === id);
            if (banner) banner.order = i;
        });
        save();
        return true;
    }

    function findById(id) {
        return banners.find((b) => b._id === id) || null;
    }

    return { listActive, listAll, create, remove, toggle, reorder, findById };
}

module.exports = { initBannerManagement };
