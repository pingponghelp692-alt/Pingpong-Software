# Country Permission System

Stage 1 of the Integration Update Package. Standalone — nothing in this
folder is required by, or modifies, the existing project. It only *reads*
the existing `rbac.js` module's public API (`COUNTRIES`, `COUNTRY_IDS`,
`ROLES`, `inScope`, `hasPermission`, `logAction`, `findById`) once it's
wired in at integration time.

## Spec coverage

| Spec item | File |
|---|---|
| Country Middleware | `middleware.js` |
| Country Validation | `middleware.js` (`validateCountryBody`), `countryRegistry.js` (`isValidCountry`) |
| Country Permission Logic | `countryRegistry.js` (`updateCountryConfig`, reuses existing `country:manage` permission) |
| Country RBAC Extension | Intentionally *not* duplicated here — the base `rbac.js` already has a full country-aware role hierarchy (Owner → Global Super Admin → Country Super Admin → Country Manager → Admin → Moderator) and an `inScope()` check. This module builds on that instead of re-inventing it. A genuinely new RBAC extension (new permission strings for Merchant/Call Hosting) belongs in the `rbac_extension/` stage, once those modules exist. |
| Country Filtering | `filtering.js` |
| Country Dashboard Filter | `middleware.js` (`attachCountryFilter`) + `filtering.js` |

## Why it's separate from rbac.js

`rbac.js` already owns "which countries exist" and "who can access which
country" — duplicating that would create two sources of truth. This module
only adds a layer on top: per-country enable/disable + metadata (currency,
timezone), reusable middleware other future modules (Merchant, Call
Hosting) can import, and a generic `resource -> country` mapping table so
those modules don't need their own bespoke country columns.

## Storage (hybrid, as requested)

- **Runtime source of truth:** flat JSON (`data/country_permission_config.json`),
  same atomic tmp-then-rename pattern as `rbac.js`.
- **Optional Postgres mirror:** if `DATABASE_URL` is set, writes are
  best-effort mirrored to a `country_permission_kv` table — same
  fire-and-forget philosophy as the existing `perf/dbPersistence.js`.
- **Real relational schema:** `migrations/001_country_permission_extension.sql`
  creates `country_config`, `country_resource_scope`, and
  `country_audit_log` — additive only, no `ALTER` on any existing table.
  Not wired up as the primary store yet; this is the scaffold for when the
  project is ready to move off JSON for this module.

## Integration (later — not done in this task)

Two lines in `server.js`, after `rbac` is constructed:

```js
const countryPermission = require("./integration_update/country_permission")
    .attach({ app, rbac, requireAdmin, requirePermission, dataFolder: path.join(__dirname, "data") });
```

That's the entire footprint — it mounts `GET/PUT /api/admin/country-permission[/:countryId]`
(deliberately a different path from the existing `GET /api/admin/countries`,
so nothing collides) and returns `{ registry, middleware, filtering }` for
later modules in this package to `require()` and reuse.
