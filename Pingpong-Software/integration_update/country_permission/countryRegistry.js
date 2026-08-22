/* ==========================================================================
   Country Permission — Registry
   ==========================================================================
   Wraps the existing rbac.js country model (rbac.COUNTRIES / COUNTRY_IDS /
   inScope) and layers this module's own extension config on top (see
   store.js). Does NOT modify rbac.js and does NOT duplicate it as the
   source of truth for "which countries exist" — rbac.js stays authoritative
   for that; this module only adds metadata + enable/disable + future
   merchant/call-rate defaults per country.

   Everything here is additive. If rbac.js's COUNTRIES list changes later,
   this module picks it up automatically (it reads rbac.COUNTRIES live,
   never caches a copy).
   ========================================================================== */

const path = require("path");
const { makeStore } = require("./store");

function makeRegistry({ rbac, dataFolder }) {
    if (!rbac) throw new Error("[country-permission] countryRegistry requires the existing rbac module instance");
    const store = makeStore(dataFolder || path.join(__dirname, "..", "data"));

    function isValidCountry(countryId) {
        return rbac.COUNTRY_IDS.includes(countryId);
    }

    // Enriches rbac's base country definition with this module's extension
    // config. Unknown/never-configured countries just get sane defaults
    // (enabled by default — this module is additive, it should never
    // silently lock a country out that the base RBAC already serves).
    function describe(countryId) {
        const base = rbac.COUNTRIES.find((c) => c.id === countryId);
        if (!base) return null;
        const ext = store.get(countryId) || {};
        return {
            id: base.id,
            name: base.name,
            superAdminSlots: base.superAdminSlots,
            adminSlots: base.adminSlots,
            enabled: ext.enabled !== undefined ? ext.enabled : true,
            currency: ext.currency || null,
            timezone: ext.timezone || null,
            notes: ext.notes || null,
            updatedAt: ext.updatedAt || null
        };
    }

    // `actor` scoping matches rbac.inScope semantics: Owner/Global Super
    // Admin see everything, everyone else only sees their own country.
    function listCountries(actor) {
        const all = rbac.COUNTRIES.map((c) => describe(c.id));
        if (!actor) return [];
        if (actor.role === rbac.ROLES.OWNER || actor.role === rbac.ROLES.GLOBAL_SUPER_ADMIN) return all;
        return all.filter((c) => c.id === actor.countryId);
    }

    function updateCountryConfig(actor, countryId, patch) {
        if (!isValidCountry(countryId)) return { success: false, message: "Unknown country" };
        // Reuses the existing "country:manage" permission already defined
        // in rbac.js (NON_OWNER_ONLY) rather than inventing a parallel one
        // — see rbac_extension/ (built in a later stage) for genuinely new
        // permission strings this package needs beyond that.
        if (!rbac.hasPermission(actor, "country:manage")) {
            return { success: false, message: "Permission denied" };
        }
        const allowed = ["enabled", "currency", "timezone", "notes"];
        const safePatch = {};
        for (const k of allowed) if (patch[k] !== undefined) safePatch[k] = patch[k];
        safePatch.updatedBy = actor.id;
        const saved = store.set(countryId, safePatch);
        rbac.logAction({
            admin: actor, action: "country-config-update", module: "country-permission",
            targetType: "country", targetId: countryId, after: saved
        });
        return { success: true, country: describe(countryId) };
    }

    return { isValidCountry, describe, listCountries, updateCountryConfig, _store: store };
}

module.exports = { makeRegistry };
