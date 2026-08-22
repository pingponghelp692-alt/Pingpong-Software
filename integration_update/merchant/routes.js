/* ==========================================================================
   Merchant — Admin Routes
   ==========================================================================
   Mounted at /api/admin/merchants (does not collide with any existing
   route — checked against server.js's full route table, and against
   country_permission's own /api/admin/country-permission mount, before
   adding). Read access: gated behind "merchant:view" (list auto-scoped
   to the acting admin's own country). Write access: gated behind
   "merchant:manage". Both permissions are defined in rbac.js's
   PERMISSIONS list with default grants mirroring agencies:view/
   agencies:manage exactly (Country Manager gets both, Admin gets view
   only) — see registry.js's header for detail. Country isolation on
   every write is enforced twice — once by country_permission's own
   requireCountryScope middleware on create, and again inside registry.js
   itself for update/status changes where the country is implied by the
   existing record rather than the request body.
   ========================================================================== */

const express = require("express");

function makeRouter({ registry, countryPermission, rbac, requireAdmin, requirePermission }) {
    const router = express.Router();
    const mw = countryPermission.middleware;

    router.get("/", requireAdmin, requirePermission(registry.VIEW_PERMISSION), mw.attachCountryFilter, (req, res) => {
        res.json({ success: true, merchants: registry.listMerchants(req.adminAccount) });
    });

    router.get("/:id", requireAdmin, requirePermission(registry.VIEW_PERMISSION), (req, res) => {
        const merchant = registry.describe(req.params.id);
        if (!merchant) return res.status(404).json({ success: false, message: "Merchant not found" });
        if (!rbac.inScope(req.adminAccount, merchant.countryId)) {
            return res.status(403).json({ success: false, message: "You don't have access to this country" });
        }
        res.json({ success: true, merchant });
    });

    router.post("/", requireAdmin, requirePermission(registry.WRITE_PERMISSION),
        mw.validateCountryBody("countryId"),
        mw.requireCountryScope((req) => req.body.countryId),
        (req, res) => {
            const result = registry.createMerchant(req.adminAccount, req.body || {});
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        });

    router.put("/:id", requireAdmin, requirePermission(registry.WRITE_PERMISSION), (req, res) => {
        const result = registry.updateMerchant(req.adminAccount, req.params.id, req.body || {});
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    router.put("/:id/status", requireAdmin, requirePermission(registry.WRITE_PERMISSION), (req, res) => {
        const result = registry.setStatus(req.adminAccount, req.params.id, (req.body || {}).status);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    return router;
}

module.exports = { makeRouter };
