/* ==========================================================================
   Country Permission — Admin Routes
   ==========================================================================
   Mounted at /api/admin/country-permission (deliberately distinct from the
   existing GET /api/admin/countries route in server.js — this module never
   touches that route or its response shape). Read access: any authenticated
   admin (results are auto-scoped to their own country via registry
   .listCountries). Write access: gated behind the existing "country:manage"
   permission, same as the current country-assignment endpoint in server.js.
   ========================================================================== */

const express = require("express");

function makeRouter({ rbac, registry, middleware, requireAdmin, requirePermission }) {
    const router = express.Router();

    router.get("/", requireAdmin, middleware.attachCountryFilter, (req, res) => {
        res.json({ success: true, countries: registry.listCountries(req.adminAccount) });
    });

    router.get("/:countryId", requireAdmin, middleware.requireCountryScope((req) => req.params.countryId), (req, res) => {
        const country = registry.describe(req.params.countryId);
        if (!country) return res.status(404).json({ success: false, message: "Unknown country" });
        res.json({ success: true, country });
    });

    router.put("/:countryId", requireAdmin, requirePermission("country:manage"),
        middleware.requireCountryScope((req) => req.params.countryId),
        (req, res) => {
            const result = registry.updateCountryConfig(req.adminAccount, req.params.countryId, req.body || {});
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        });

    return router;
}

module.exports = { makeRouter };
