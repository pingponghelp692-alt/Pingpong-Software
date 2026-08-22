/* ==========================================================================
   Merchant — Package Entry Point
   ==========================================================================
   Same shape as integration_update/country_permission/index.js: everything
   this module needs from the host app (and from country_permission) is
   passed in — it never requires ../../rbac.js or ../../server.js by
   relative path, so this folder stays self-contained until integration
   time. Depends on country_permission (must be attached first) for
   country validity checks and scoping middleware, per
   country_permission/README.md's own "Next stage" note.

   Integrating this into server.js is exactly:

       const countryPermission = require("./integration_update/country_permission")
           .attach({ app, rbac, requireAdmin, requirePermission, dataFolder: path.join(__dirname, "data") });
       const merchant = require("./integration_update/merchant")
           .attach({ app, rbac, requireAdmin, requirePermission, countryPermission, dataFolder: path.join(__dirname, "data") });
   ========================================================================== */

const path = require("path");
const { makeRegistry } = require("./registry");
const { makeRouter } = require("./routes");

function attach({ app, rbac, requireAdmin, requirePermission, countryPermission, dataFolder, mountPath }) {
    if (!app || !rbac || !requireAdmin || !requirePermission) {
        throw new Error("[merchant] attach() requires { app, rbac, requireAdmin, requirePermission }");
    }
    if (!countryPermission) {
        throw new Error("[merchant] attach() requires the already-attached country_permission module (pass its attach() return value as countryPermission)");
    }
    const registry = makeRegistry({ rbac, countryPermission, dataFolder: dataFolder || path.join(__dirname, "..", "data") });
    const router = makeRouter({ registry, countryPermission, rbac, requireAdmin, requirePermission });

    if (app) app.use(mountPath || "/api/admin/merchants", router);

    return { registry, router };
}

module.exports = { attach };
