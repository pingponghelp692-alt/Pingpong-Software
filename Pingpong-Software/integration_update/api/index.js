/* ==========================================================================
   API — Shared Route Index
   ==========================================================================
   Exactly what integration_update/api/README.md's placeholder described:
   "shared route index across modules." This does NOT replace how
   server.js currently attaches country_permission and merchant — those
   two require(...).attach(...) calls in server.js keep working exactly
   as they are (per the project rule: never replace working code). This
   module is an additive, optional convenience for future modules and for
   introspection: a single manifest describing every mount point this
   package defines, plus a helper to attach several modules in one call
   when a future integration wants that instead of one require line per
   module.

   Usage (introspection — e.g. an admin "installed extensions" panel):
       const { MOUNTS } = require("./integration_update/api");
       // MOUNTS => [{ name: "country_permission", mountPath: "/api/admin/country-permission" }, ...]

   Usage (optional attach-everything helper, for a FUTURE server.js if it
   ever wants one require instead of two — not used today, existing
   server.js wiring is untouched):
       const { attachAll } = require("./integration_update/api");
       const attached = attachAll({ app, rbac, requireAdmin, requirePermission, dataFolder });
       // attached.countryPermission, attached.merchant
   ========================================================================== */

const path = require("path");

// Static manifest, kept in sync by hand as modules are added — mirrors
// each module's own mountPath default (see each module's index.js).
// Order matters for attachAll: country_permission before merchant,
// same dependency reason as database/index.js's PRIORITY_ORDER.
const MOUNTS = [
    { name: "country_permission", mountPath: "/api/admin/country-permission", require: "../country_permission" },
    { name: "merchant", mountPath: "/api/admin/merchants", require: "../merchant" }
];

// Attaches every listed module, in manifest order, wiring merchant's
// dependency on the already-attached country_permission automatically.
// Returns { <name>: <attach() return value> } for each. Throws if a
// required dependency isn't available yet — same validation each
// module's own attach() already does, not duplicated here.
function attachAll({ app, rbac, requireAdmin, requirePermission, dataFolder }) {
    const attached = {};
    for (const mount of MOUNTS) {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(mount.require);
        const opts = { app, rbac, requireAdmin, requirePermission, dataFolder, mountPath: mount.mountPath };
        if (mount.name === "merchant") opts.countryPermission = attached.country_permission;
        attached[mount.name] = mod.attach(opts);
    }
    return attached;
}

module.exports = { MOUNTS, attachAll };
