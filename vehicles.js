// ==================================================
// VEHICLE ENTRY SYSTEM (Add-on Module)
// ==================================================
// Pure add-on, modeled on the existing Frames / Coin Sellers modules —
// does NOT touch any existing route, socket event, or data file.
//
// - Admin manages a Vehicle Catalog (thumbnail + full-screen entry video +
//   optional background music + optional entry sound effect).
// - Admin can assign a vehicle directly to any user by User ID or
//   Username — permanent or temporary — completely independent of any
//   purchase/shop system (none exists for this yet, by design — see the
//   feature doc's "Future Ready" section).
// - Assigned vehicles land in the user's own inventory
//   (user.vehicleInventory, a new field added the same way
//   user.activeFrame was — safe on old accounts via the default in
//   server.js's user-migration loop). The user can then pick ONE as
//   their Active Vehicle (user.activeVehicleId), same UX shape as
//   Frame/Badge/Name Effect "select and use".
// - server.js's existing join-room handler calls getUserActiveVehicle()
//   (exported below) and broadcasts a NEW "vehicle-entry" socket event to
//   just that room — never touching the existing room-state/seat/frame
//   broadcasts already happening there.
//
// Data files (new, additive):
//   vehicle_catalog.json      — the catalog itself
//   vehicle_assignments.json  — append-only assignment/unassignment history

const crypto = require("crypto");
const path = require("path");

function initVehicles(deps) {
    const {
        app, fs, DATA_FOLDER,
        safeRead, safeWrite,
        findUserByUserId, saveUsers, users,
        io, socketsByUserId, emitToUser,
        rbac, requireAdmin, requirePermission,
        reqUserAgent,
        userAuth,
        uploadVehicle,
        VEHICLE_THUMB_FOLDER, VEHICLE_VIDEO_FOLDER, VEHICLE_AUDIO_FOLDER
    } = deps;

    const CATALOG_FILE = path.join(DATA_FOLDER, "vehicle_catalog.json");
    const ASSIGNMENTS_FILE = path.join(DATA_FOLDER, "vehicle_assignments.json");

    let vehicleCatalog = safeRead(CATALOG_FILE, []);
    function saveCatalog() { safeWrite(CATALOG_FILE, vehicleCatalog); }

    let assignmentHistory = safeRead(ASSIGNMENTS_FILE, []);
    function saveHistory() { safeWrite(ASSIGNMENTS_FILE, assignmentHistory); }
    function logAssignment(entry) {
        assignmentHistory.unshift(Object.assign({ id: "vha_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"), at: new Date().toISOString() }, entry));
        if (assignmentHistory.length > 2000) assignmentHistory = assignmentHistory.slice(0, 2000); // keep the file bounded, same trimming idea as gift_log
        saveHistory();
    }

    function actorTag(req) { return { id: req.adminAccount.id, username: req.adminAccount.username }; }

    function publicVehicle(v) {
        return {
            id: v.id, name: v.name, description: v.description || "",
            thumbnailUrl: v.thumbnailUrl, videoUrl: v.videoUrl,
            musicUrl: v.musicUrl || null, soundUrl: v.soundUrl || null,
            durationSeconds: v.durationSeconds || 5,
            premium: !!v.premium, limitedEdition: !!v.limitedEdition,
            expiryDate: v.expiryDate || null,
            displayOrder: v.displayOrder || 0,
            enabled: v.enabled !== false
        };
    }

    function catalogVehicle(id) { return vehicleCatalog.find((v) => v.id === id); }

    // A catalog vehicle can be time-limited itself (Limited Edition /
    // Expiry Date on the catalog item, per the feature doc) — separate
    // from a per-assignment expiry below.
    function isCatalogLive(v) {
        if (!v || v.enabled === false) return false;
        if (v.expiryDate && new Date(v.expiryDate).getTime() < Date.now()) return false;
        return true;
    }

    // Drops expired assignment entries from a user's inventory in place;
    // returns true if anything changed (caller decides whether to persist).
    function pruneExpiredInventory(user) {
        if (!Array.isArray(user.vehicleInventory)) { user.vehicleInventory = []; return false; }
        const before = user.vehicleInventory.length;
        user.vehicleInventory = user.vehicleInventory.filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now());
        if (user.activeVehicleId && !user.vehicleInventory.some((e) => e.vehicleId === user.activeVehicleId)) {
            user.activeVehicleId = null;
        }
        return user.vehicleInventory.length !== before;
    }

    // Used by server.js's join-room handler. Returns the full playable
    // vehicle (catalog + duration + urls) for a user's current active
    // vehicle, or null if they have none / it's expired / it got disabled
    // or deleted from the catalog since being assigned.
    function getUserActiveVehicle(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const user = found.user;
        if (pruneExpiredInventory(user)) saveUsers();
        if (!user.activeVehicleId) return null;
        const v = catalogVehicle(user.activeVehicleId);
        if (!isCatalogLive(v)) return null;
        return publicVehicle(v);
    }

    // --------------------------------------------------
    // USER — My Vehicles (inventory) + Customize tab
    // --------------------------------------------------
    app.get("/api/vehicles/mine/:userId", userAuth.requireUserAuth, (req, res) => {
        const actor = users[req.authedMobile];
        if (!actor || actor.userId !== req.params.userId) {
            return res.status(403).json({ success: false, message: "You can only view your own vehicle inventory" });
        }
        const found = findUserByUserId(req.params.userId);
        if (!found) return res.json({ success: false, message: "User not found" });
        const user = found.user;
        if (pruneExpiredInventory(user)) saveUsers();
        const inventory = (user.vehicleInventory || []).map((entry) => {
            const v = catalogVehicle(entry.vehicleId);
            if (!v) return null; // deleted from catalog since assignment — never shown with fabricated data
            return Object.assign(publicVehicle(v), {
                assignedAt: entry.assignedAt,
                expiresAt: entry.expiresAt || null,
                permanent: !!entry.permanent,
                active: user.activeVehicleId === entry.vehicleId
            });
        }).filter(Boolean);
        res.json({ success: true, activeVehicleId: user.activeVehicleId || null, inventory });
    });

    app.post("/api/vehicles/use", userAuth.requireUserAuth, (req, res) => {
        const { vehicleId } = req.body;
        const actor = users[req.authedMobile];
        if (!actor) return res.status(401).json({ success: false, message: "User not found" });
        const userId = actor.userId;
        const found = findUserByUserId(userId);
        if (!found) return res.json({ success: false, message: "User not found" });
        const user = found.user;
        if (pruneExpiredInventory(user)) saveUsers();
        const owns = (user.vehicleInventory || []).some((e) => e.vehicleId === vehicleId);
        if (!owns) return res.json({ success: false, message: "You don't own this Vehicle" });
        const v = catalogVehicle(vehicleId);
        if (!isCatalogLive(v)) return res.json({ success: false, message: "This Vehicle is no longer available" });
        user.activeVehicleId = vehicleId;
        saveUsers();
        emitToUser(user.userId, "vehicle-active-updated", { activeVehicleId: vehicleId }); // GAP #1 — cross-instance-safe
        res.json({ success: true, activeVehicleId: vehicleId });
    });

    app.post("/api/vehicles/deactivate", userAuth.requireUserAuth, (req, res) => {
        const actor = users[req.authedMobile];
        if (!actor) return res.status(401).json({ success: false, message: "User not found" });
        const userId = actor.userId;
        const found = findUserByUserId(userId);
        if (!found) return res.json({ success: false, message: "User not found" });
        found.user.activeVehicleId = null;
        saveUsers();
        emitToUser(found.user.userId, "vehicle-active-updated", { activeVehicleId: null }); // GAP #1 — cross-instance-safe
        res.json({ success: true });
    });

    // --------------------------------------------------
    // ADMIN — Vehicle Management (catalog CRUD)
    // --------------------------------------------------
    app.get("/api/admin/vehicles", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const list = vehicleCatalog.slice().sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
        res.json({ success: true, vehicles: list });
    });

    app.post("/api/admin/vehicles/upload", requireAdmin, requirePermission("vehicles:manage"), uploadVehicle.fields([
        { name: "thumbnail", maxCount: 1 },
        { name: "video", maxCount: 1 },
        { name: "music", maxCount: 1 },
        { name: "sound", maxCount: 1 }
    ]), (req, res) => {
        const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
        const videoFile = req.files && req.files.video && req.files.video[0];
        const musicFile = req.files && req.files.music && req.files.music[0];
        const soundFile = req.files && req.files.sound && req.files.sound[0];
        const name = String(req.body.name || "").trim();
        if (!name) return res.json({ success: false, message: "Enter a Vehicle Name" });
        if (!thumbFile) return res.json({ success: false, message: "Provide a Thumbnail Image" });
        if (!videoFile) return res.json({ success: false, message: "Provide an Entry Video (MP4/WebM)" });
        let durationSeconds = Number(req.body.durationSeconds);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) durationSeconds = 5;
        const vehicle = {
            id: "veh_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
            name,
            description: String(req.body.description || "").trim(),
            thumbnailUrl: "/vehicle-thumbs/" + thumbFile.filename,
            videoUrl: "/vehicle-videos/" + videoFile.filename,
            musicUrl: musicFile ? ("/vehicle-audio/" + musicFile.filename) : null,
            soundUrl: soundFile ? ("/vehicle-audio/" + soundFile.filename) : null,
            durationSeconds,
            premium: req.body.premium === "true" || req.body.premium === true,
            limitedEdition: req.body.limitedEdition === "true" || req.body.limitedEdition === true,
            expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate).toISOString() : null,
            displayOrder: Number(req.body.displayOrder) || 0,
            enabled: true,
            createdAt: new Date().toISOString()
        };
        vehicleCatalog.push(vehicle);
        saveCatalog();
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-upload", module: "vehicles", targetType: "vehicle", targetId: vehicle.id, after: vehicle, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, vehicle });
    });

    app.post("/api/admin/vehicles/:id/update", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const v = catalogVehicle(req.params.id);
        if (!v) return res.json({ success: false, message: "Vehicle not found" });
        const { name, description, durationSeconds, premium, limitedEdition, expiryDate, displayOrder, enabled } = req.body;
        if (name !== undefined && String(name).trim()) v.name = String(name).trim();
        if (description !== undefined) v.description = String(description).trim();
        if (durationSeconds !== undefined) {
            const d = Number(durationSeconds);
            if (Number.isFinite(d) && d > 0) v.durationSeconds = d;
        }
        if (premium !== undefined) v.premium = premium === true || premium === "true";
        if (limitedEdition !== undefined) v.limitedEdition = limitedEdition === true || limitedEdition === "true";
        if (expiryDate !== undefined) v.expiryDate = expiryDate ? new Date(expiryDate).toISOString() : null;
        if (displayOrder !== undefined) v.displayOrder = Number(displayOrder) || 0;
        if (enabled !== undefined) v.enabled = enabled === true || enabled === "true";
        saveCatalog();
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-update", module: "vehicles", targetType: "vehicle", targetId: v.id, after: v, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, vehicle: v });
    });

    app.post("/api/admin/vehicles/:id/toggle", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const v = catalogVehicle(req.params.id);
        if (!v) return res.json({ success: false, message: "Vehicle not found" });
        v.enabled = !(v.enabled !== false);
        saveCatalog();
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-toggle", module: "vehicles", targetType: "vehicle", targetId: v.id, after: { enabled: v.enabled }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, vehicle: v });
    });

    app.delete("/api/admin/vehicles/:id", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const idx = vehicleCatalog.findIndex((v) => v.id === req.params.id);
        if (idx === -1) return res.json({ success: false, message: "Vehicle not found" });
        const [removed] = vehicleCatalog.splice(idx, 1);
        saveCatalog();
        // Best-effort file cleanup — never block the response on this.
        [removed.thumbnailUrl, removed.videoUrl, removed.musicUrl, removed.soundUrl].filter(Boolean).forEach((url) => {
            try { fs.unlinkSync(path.join(__dirname, url)); } catch (_) {}
        });
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-delete", module: "vehicles", targetType: "vehicle", targetId: removed.id, before: removed, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true });
    });

    // --------------------------------------------------
    // ADMIN — Assign / Unassign to a specific user (no purchase system)
    // --------------------------------------------------
    // "target" accepts either a User ID or a Username — tries User ID
    // first (exact, same convention as every other admin "target" field
    // in this codebase), then falls back to a case-insensitive name match.
    function resolveTarget(target) {
        if (!target) return null;
        const byId = findUserByUserId(target);
        if (byId) return byId;
        const needle = String(target).trim().toLowerCase();
        const entry = Object.entries(users).find(([, u]) => (u.name || "").trim().toLowerCase() === needle);
        return entry ? { mobile: entry[0], user: entry[1] } : null;
    }

    app.post("/api/admin/vehicles/assign", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const { target, vehicleId, permanent, expiryDays } = req.body;
        const found = resolveTarget(target);
        if (!found) return res.json({ success: false, message: "Provide a valid Target User ID or Username" });
        const v = catalogVehicle(vehicleId);
        if (!v) return res.json({ success: false, message: "Vehicle not found in catalog" });
        const user = found.user;
        if (!Array.isArray(user.vehicleInventory)) user.vehicleInventory = [];
        const isPermanent = permanent === true || permanent === "true" || !expiryDays;
        const days = Number(expiryDays);
        const expiresAt = isPermanent ? null : new Date(Date.now() + (Number.isFinite(days) ? days : 0) * 86400000).toISOString();
        // Re-assigning a vehicle the user already has just refreshes the entry
        // (new expiry/permanence) instead of creating a duplicate row.
        const existingIdx = user.vehicleInventory.findIndex((e) => e.vehicleId === vehicleId);
        const entry = { vehicleId, assignedAt: new Date().toISOString(), expiresAt, permanent: isPermanent, assignedBy: actorTag(req) };
        if (existingIdx >= 0) user.vehicleInventory[existingIdx] = entry; else user.vehicleInventory.push(entry);
        saveUsers();
        logAssignment({ userId: user.userId, userName: user.name || "", vehicleId, vehicleName: v.name, action: "assign", permanent: isPermanent, expiresAt, admin: actorTag(req) });
        emitToUser(user.userId, "vehicle-inventory-updated", {}); // GAP #1 — cross-instance-safe
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-assign", module: "vehicles", targetType: "user", targetId: user.userId, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, assignment: entry });
    });

    app.post("/api/admin/vehicles/unassign", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const { userId, vehicleId } = req.body;
        const found = findUserByUserId(userId);
        if (!found) return res.json({ success: false, message: "User not found" });
        const user = found.user;
        const before = (user.vehicleInventory || []).find((e) => e.vehicleId === vehicleId);
        user.vehicleInventory = (user.vehicleInventory || []).filter((e) => e.vehicleId !== vehicleId);
        if (user.activeVehicleId === vehicleId) user.activeVehicleId = null;
        saveUsers();
        const v = catalogVehicle(vehicleId);
        logAssignment({ userId: user.userId, userName: user.name || "", vehicleId, vehicleName: v ? v.name : vehicleId, action: "unassign", admin: actorTag(req) });
        emitToUser(user.userId, "vehicle-inventory-updated", {}); // GAP #1 — cross-instance-safe
        rbac.logAction({ admin: req.adminAccount, action: "vehicle-unassign", module: "vehicles", targetType: "user", targetId: user.userId, before, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true });
    });

    app.get("/api/admin/vehicles/history", requireAdmin, requirePermission("vehicles:manage"), (req, res) => {
        const { userId } = req.query;
        const list = userId ? assignmentHistory.filter((h) => h.userId === userId) : assignmentHistory;
        res.json({ success: true, history: list.slice(0, 200) });
    });

    // Turns multer errors (wrong file type, over the size limit) into a
    // normal JSON response instead of an HTML crash page — same guard the
    // Video Gifts routes use.
    app.use("/api/admin/vehicles", (err, req, res, next) => {
        if (err) return res.status(400).json({ success: false, message: err.message || "Upload failed" });
        next();
    });

    return { vehicleCatalog, getUserActiveVehicle };
}

module.exports = { initVehicles };
