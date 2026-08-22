# Database (shared migrations index)

**Built.** `index.js` discovers every `integration_update/*/migrations/*.sql`
file and runs them (or lists them, with `--dry-run`) in a stable,
dependency-safe order — `country_permission` always first (later modules'
migrations may reference its tables), everything else alphabetical.

Inert by default: `require("./integration_update/database")` does nothing
on its own, and `run()` is a safe no-op if `DATABASE_URL` isn't set (the
JSON stores stay the source of truth, same as every module in this
package). Nothing in `server.js` calls this automatically — it's a manual
operator tool:

```
node integration_update/database/index.js --dry-run   # list only
node integration_update/database/index.js              # actually run
```

## Currently discovers

1. `country_permission/001_country_permission_extension.sql`
2. `merchant/001_merchant_extension.sql`

Verified via `--dry-run` (correct order) and a no-`DATABASE_URL` run
(correct no-op).
