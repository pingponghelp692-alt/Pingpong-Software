// ==================================================
// WALLET — COIN SELLER LIST
// ==================================================
// Replaces the Wallet page's old "Diamond → Coin Exchange (Admin
// Approval)" request card with a real-time list of coin sellers a buyer
// can contact directly (Chat / WhatsApp). This is intentionally a
// SEPARATE, much simpler module from diamondSeller.js: there is no
// KYC/approval workflow here — an Admin (holding coin-seller:manage)
// just attaches an existing real user by User ID, and this module reads
// that user's LIVE profile (avatar, name, country, online status) from
// the app's real user database on every request. Nothing about
// diamondSeller.js / its approval workflow / its admin UI is touched by
// this file.
//
// Data stored here (coin_sellers.json) is ONLY the admin-curated list of
// which User IDs are sellers, their display order, and — only when the
// user's own profile doesn't already carry one — a WhatsApp number for
// that seller. Every other field shown on a seller card (avatar, name,
// country, online/offline) is fetched live via findUserByUserId, never
// cached/duplicated here, so the list always reflects the current user
// record.
//
// "Past 30 days' order" — honesty note: this codebase's only existing
// real "seller completed an order" event is the Diamond Seller module's
// wallet-integrated sale (diamondSeller.js logs a
// "Diamond Seller Commission (...)" transaction to the seller's userId
// on each recorded sale). Since this module is not given its own
// order-recording endpoint (out of scope per spec — Admin only
// Adds/Deletes/Reorders sellers here), order_count_last_30_days is
// computed by counting that same real transaction-log event for the
// seller's userId in the last 30 days. If a listed Coin Seller has never
// had one (e.g. they aren't also an approved Diamond Seller), the count
// is honestly 0 — never fabricated.

const path = require("path");

function initCoinSellers(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        findUserByUserId, getTransactions,
        io, socketsByUserId,
        rbac, requireAdmin, requirePermission, reqUserAgent
    } = deps;

    function actorTag(req) { return { id: req.adminAccount.id, username: req.adminAccount.username }; }

    const SELLERS_FILE = path.join(DATA_FOLDER, "coin_sellers.json");
    let sellers = safeRead(SELLERS_FILE, {}); // keyed by userId
    function saveSellers() { safeWrite(SELLERS_FILE, sellers); }

    function orderCountLast30Days(userId) {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const transactions = getTransactions();
        let count = 0;
        for (const t of transactions) {
            if (t.userId !== userId) continue;
            if (typeof t.note !== "string" || t.note.indexOf("Diamond Seller Commission") !== 0) continue;
            if (new Date(t.time).getTime() < cutoff) continue;
            count++;
        }
        return count;
    }

    function publicSellerView(record) {
        const found = findUserByUserId(record.userId);
        if (!found) return null; // user account no longer exists — never shown with fabricated data
        const user = found.user;
        return {
            user_id: user.userId,
            username: user.name,
            display_name: user.name,
            avatar: user.photo || "",
            country: user.country || "",
            is_online: !!socketsByUserId[user.userId],
            whatsapp_number: user.whatsappNumber || record.whatsappNumber || "",
            order_count_last_30_days: orderCountLast30Days(user.userId)
        };
    }

    // --------------------------------------------------
    // PUBLIC — used by the Wallet page's Coin Seller List.
    // --------------------------------------------------
    app.get("/api/wallet/coin-sellers", (req, res) => {
        const list = Object.values(sellers)
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map(publicSellerView)
            .filter(Boolean);
        res.json({ success: true, sellers: list });
    });

    // --------------------------------------------------
    // ADMIN — Manage Coin Sellers
    // --------------------------------------------------
    app.get("/api/admin/coin-sellers", requireAdmin, requirePermission("coin-seller:view"), (req, res) => {
        const list = Object.values(sellers)
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map((record) => {
                const view = publicSellerView(record);
                return view ? Object.assign({}, view, { addedAt: record.addedAt, addedBy: record.addedBy }) : {
                    user_id: record.userId, missing: true, addedAt: record.addedAt, addedBy: record.addedBy
                };
            });
        res.json({ success: true, sellers: list });
    });

    app.post("/api/admin/coin-sellers/add", requireAdmin, requirePermission("coin-seller:manage"), (req, res) => {
        const userId = String(req.body.userId || "").trim();
        if (!userId) return res.json({ success: false, message: "Provide a User ID" });
        if (sellers[userId]) return res.json({ success: false, message: "This user is already on the Coin Seller List" });
        const found = findUserByUserId(userId);
        if (!found) return res.json({ success: false, message: "Provide a valid User ID (must be an existing user)" });

        const whatsappNumber = String(req.body.whatsappNumber || "").trim();
        if (!found.user.whatsappNumber && !whatsappNumber) {
            return res.json({ success: false, message: "This user's profile has no WhatsApp Number — provide one here" });
        }

        const maxOrder = Object.values(sellers).reduce((m, s) => Math.max(m, s.order || 0), 0);
        sellers[found.user.userId] = {
            userId: found.user.userId,
            whatsappNumber: found.user.whatsappNumber ? "" : whatsappNumber,
            order: maxOrder + 1,
            addedAt: new Date().toISOString(),
            addedBy: actorTag(req)
        };
        saveSellers();
        rbac.logAction({
            admin: req.adminAccount, action: "coin-seller-add", module: "coin-seller",
            targetType: "coin-seller", targetId: found.user.userId,
            after: sellers[found.user.userId], ip: req.ip, userAgent: reqUserAgent(req)
        });
        res.json({ success: true, seller: publicSellerView(sellers[found.user.userId]) });
    });

    app.post("/api/admin/coin-sellers/:userId/remove", requireAdmin, requirePermission("coin-seller:manage"), (req, res) => {
        const record = sellers[req.params.userId];
        if (!record) return res.json({ success: false, message: "Seller not found" });
        delete sellers[req.params.userId];
        saveSellers();
        rbac.logAction({
            admin: req.adminAccount, action: "coin-seller-remove", module: "coin-seller",
            targetType: "coin-seller", targetId: req.params.userId,
            before: record, ip: req.ip, userAgent: reqUserAgent(req)
        });
        res.json({ success: true });
    });

    // Body: { orderedUserIds: [userId, userId, ...] } — full ordered list,
    // exactly as shown by GET /api/admin/coin-sellers.
    app.post("/api/admin/coin-sellers/reorder", requireAdmin, requirePermission("coin-seller:manage"), (req, res) => {
        const orderedUserIds = Array.isArray(req.body.orderedUserIds) ? req.body.orderedUserIds : null;
        if (!orderedUserIds) return res.json({ success: false, message: "Provide orderedUserIds" });
        orderedUserIds.forEach((userId, idx) => {
            if (sellers[userId]) sellers[userId].order = idx + 1;
        });
        saveSellers();
        rbac.logAction({
            admin: req.adminAccount, action: "coin-seller-reorder", module: "coin-seller",
            targetType: "coin-seller", targetId: "bulk",
            after: { orderedUserIds }, ip: req.ip, userAgent: reqUserAgent(req)
        });
        res.json({ success: true });
    });

    return { sellers, saveSellers };
}

module.exports = { initCoinSellers };
