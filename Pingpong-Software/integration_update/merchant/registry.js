/* ==========================================================================
   Merchant — Registry
   ==========================================================================
   Core CRUD logic for merchant records. Reuses the existing rbac.js
   instance (for hasPermission/logAction/actor shape) and this package's
   own country_permission module (for country validity + scoping) exactly
   the way country_permission/README.md's "Next stage" note describes —
   nothing here duplicates country validation or re-implements scoping.

   Permissions: "merchant:view" (reads) and "merchant:manage" (writes) —
   added to rbac.js's PERMISSIONS list by the rbac_extension stage
   (integration_update/rbac_extension), granted by default to Country
   Manager (both) and Admin (view only), mirroring the existing
   agencies:view/agencies:manage asymmetry. Earlier revisions of this
   module (before rbac_extension) temporarily reused the existing
   "agencies:manage" permission for writes and left reads ungated,
   following country_permission's own more lenient pattern; this was
   flagged in that revision as a placeholder to fix once real permission
   strings existed. rbac_extension now provides them, so this module uses
   its own, purpose-built permissions like every other feature in the
   main app (agencies, gifts, vip, recharge, withdraw, frames, namefx,
   ban all gate reads behind a :view permission too).
   ========================================================================== */

const crypto = require("crypto");
const path = require("path");
const { makeStore } = require("./store");

const VIEW_PERMISSION = "merchant:view";
const WRITE_PERMISSION = "merchant:manage";
const STATUSES = ["pending", "active", "suspended"];

function makeRegistry({ rbac, countryPermission, dataFolder }) {
    if (!rbac) throw new Error("[merchant] registry requires the existing rbac module instance");
    if (!countryPermission) throw new Error("[merchant] registry requires the country_permission module instance");
    const store = makeStore(dataFolder || path.join(__dirname, "..", "data"));

    function describe(id) {
        return store.get(id);
    }

    function listMerchants(actor) {
        const all = Object.values(store.getAll());
        if (!actor) return [];
        if (actor.role === rbac.ROLES.OWNER || actor.role === rbac.ROLES.GLOBAL_SUPER_ADMIN) return all;
        return all.filter((m) => m.countryId === actor.countryId);
    }

    function canWrite(actor) {
        return !!actor && rbac.hasPermission(actor, WRITE_PERMISSION);
    }

    function createMerchant(actor, patch) {
        if (!canWrite(actor)) return { success: false, message: "Permission denied" };
        const name = String((patch && patch.name) || "").trim();
        if (!name) return { success: false, message: "Merchant name is required" };
        const countryId = patch && patch.countryId;
        if (!countryId || !countryPermission.registry.isValidCountry(countryId)) {
            return { success: false, message: "A valid countryId is required" };
        }
        if (!rbac.inScope(actor, countryId)) {
            return { success: false, message: "You don't have access to this country" };
        }
        const id = "mch_" + crypto.randomBytes(8).toString("hex");
        const now = new Date().toISOString();
        const record = {
            id,
            name,
            countryId,
            contact: (patch && String(patch.contact || "").trim()) || null,
            status: "pending",
            notes: (patch && String(patch.notes || "").trim()) || null,
            createdBy: actor.id,
            createdAt: now,
            updatedBy: actor.id,
            updatedAt: now
        };
        store.set(id, record);
        rbac.logAction({
            admin: actor, action: "merchant-create", module: "merchant",
            targetType: "merchant", targetId: id, after: record
        });
        return { success: true, merchant: record };
    }

    function updateMerchant(actor, id, patch) {
        if (!canWrite(actor)) return { success: false, message: "Permission denied" };
        const existing = store.get(id);
        if (!existing) return { success: false, message: "Merchant not found" };
        if (!rbac.inScope(actor, existing.countryId)) {
            return { success: false, message: "You don't have access to this country" };
        }
        const before = Object.assign({}, existing);
        const allowed = ["name", "contact", "notes"];
        for (const k of allowed) {
            if (patch && patch[k] !== undefined) existing[k] = String(patch[k]).trim() || null;
        }
        existing.updatedBy = actor.id;
        existing.updatedAt = new Date().toISOString();
        store.set(id, existing);
        rbac.logAction({
            admin: actor, action: "merchant-update", module: "merchant",
            targetType: "merchant", targetId: id, before, after: existing
        });
        return { success: true, merchant: existing };
    }

    function setStatus(actor, id, status) {
        if (!canWrite(actor)) return { success: false, message: "Permission denied" };
        if (!STATUSES.includes(status)) return { success: false, message: "Invalid status" };
        const existing = store.get(id);
        if (!existing) return { success: false, message: "Merchant not found" };
        if (!rbac.inScope(actor, existing.countryId)) {
            return { success: false, message: "You don't have access to this country" };
        }
        const before = existing.status;
        existing.status = status;
        existing.updatedBy = actor.id;
        existing.updatedAt = new Date().toISOString();
        store.set(id, existing);
        rbac.logAction({
            admin: actor, action: "merchant-status-change", module: "merchant",
            targetType: "merchant", targetId: id, before: { status: before }, after: { status }
        });
        return { success: true, merchant: existing };
    }

    return { describe, listMerchants, createMerchant, updateMerchant, setStatus, canWrite, STATUSES, VIEW_PERMISSION, WRITE_PERMISSION, _store: store };
}

module.exports = { makeRegistry };
