/* ==========================================================================
   Country Permission — Package Entry Point
   ==========================================================================
   Everything this module needs from the host app is passed in — it never
   requires ../../rbac.js or ../../server.js by relative path, so this
   folder stays a self-contained package until integration time. At that
   point, wiring it into server.js is exactly the two lines shown below
   (see this folder's README.md for the full integration note).

       const countryPermission = require("./integration_update/country_permission")
           .attach({ app, rbac, requireAdmin, requirePermission, dataFolder: path.join(__dirname, "data") });

       // countryPermission.middleware / .filtering / .registry are then
       // available for the Merchant / Call Hosting modules built in later
       // stages of this package to import and reuse.
   ========================================================================== */

const path = require("path");
const { makeRegistry } = require("./countryRegistry");
const { makeMiddleware } = require("./middleware");
const filtering = require("./filtering");
const { makeRouter } = require("./routes");

function attach({ app, rbac, requireAdmin, requirePermission, dataFolder, mountPath }) {
    if (!app || !rbac || !requireAdmin || !requirePermission) {
        throw new Error("[country-permission] attach() requires { app, rbac, requireAdmin, requirePermission }");
    }
    const registry = makeRegistry({ rbac, dataFolder: dataFolder || path.join(__dirname, "..", "data") });
    const middleware = makeMiddleware({ rbac, registry });
    const router = makeRouter({ rbac, registry, middleware, requireAdmin, requirePermission });

    if (app) app.use(mountPath || "/api/admin/country-permission", router);

    return { registry, middleware, filtering, router };
}

module.exports = { attach };
