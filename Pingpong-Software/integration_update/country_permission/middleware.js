/* ==========================================================================
   Country Permission — Middleware
   ==========================================================================
   Express middleware built on top of the existing requireAdmin (which sets
   req.adminAccount) and rbac.inScope. Intended for reuse by the Merchant,
   Call Hosting, and Admin Panel extension modules built in later stages of
   this package, so every one of them enforces country isolation the same
   way instead of re-implementing the check.

   None of this replaces or wraps requireAdmin/requirePermission from
   server.js — it composes with them. Typical use in a later module:

       router.post("/merchants", requireAdmin, requirePermission("merchant:create"),
           countryPermission.middleware.validateCountryBody("countryId"),
           countryPermission.middleware.requireCountryScope(req => req.body.countryId),
           handler);
   ========================================================================== */

function makeMiddleware({ rbac, registry }) {
    // Blocks the request unless the acting admin is in-scope for the
    // country resolved by `getCountryId(req)`. Owner/Global Super Admin
    // always pass (matches rbac.inScope). Must run AFTER requireAdmin.
    function requireCountryScope(getCountryId) {
        return (req, res, next) => {
            const actor = req.adminAccount;
            if (!actor) return res.status(401).json({ success: false, message: "Unauthorized" });
            const countryId = getCountryId(req);
            if (countryId && !registry.isValidCountry(countryId)) {
                return res.status(400).json({ success: false, message: "Unknown country: " + countryId });
            }
            if (!rbac.inScope(actor, countryId)) {
                rbac.logAction({
                    admin: actor, action: "country-scope-denied", module: "country-permission",
                    targetType: "country", targetId: countryId,
                    meta: { path: req.originalUrl }, result: "failed",
                    failureReason: "actor country " + actor.countryId + " cannot access " + countryId
                });
                return res.status(403).json({ success: false, message: "You don't have access to this country" });
            }
            next();
        };
    }

    // Validates that a country id supplied in the request body/params is a
    // real, currently-enabled country before it's allowed to be attached
    // to a new resource (a Merchant, a Call Host, etc.).
    function validateCountryBody(field) {
        return (req, res, next) => {
            const countryId = req.body ? req.body[field] : undefined;
            if (!countryId) return res.status(400).json({ success: false, message: `Missing ${field}` });
            if (!registry.isValidCountry(countryId)) {
                return res.status(400).json({ success: false, message: "Unknown country: " + countryId });
            }
            const desc = registry.describe(countryId);
            if (!desc.enabled) {
                return res.status(400).json({ success: false, message: "This country is currently disabled" });
            }
            next();
        };
    }

    // Sets req.countryScope: null for global-access actors (Owner/Global
    // Super Admin), otherwise the actor's own countryId. Handlers/filtering
    // helpers use this instead of re-deriving scope themselves. Must run
    // AFTER requireAdmin.
    function attachCountryFilter(req, res, next) {
        const actor = req.adminAccount;
        if (!actor) return res.status(401).json({ success: false, message: "Unauthorized" });
        const isGlobal = actor.role === rbac.ROLES.OWNER || actor.role === rbac.ROLES.GLOBAL_SUPER_ADMIN;
        req.countryScope = isGlobal ? null : actor.countryId;
        next();
    }

    return { requireCountryScope, validateCountryBody, attachCountryFilter };
}

module.exports = { makeMiddleware };
