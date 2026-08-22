# Merchant Module

**Built.** Wired into `server.js`, mounted at `/api/admin/merchants`.

Standalone package, following the exact approach used by
`country_permission/`: everything the module needs from the host app is
passed into a single `attach({ app, rbac, requireAdmin, requirePermission,
countryPermission, dataFolder })` call — no relative `require` of
`../../rbac.js` or `../../server.js`, own JSON data file
(`data/merchants.json`), own optional Postgres mirror table
(`merchant_kv`), additive-only migration SQL.

## What it does

A simple, country-scoped Merchant directory for admins:

- `GET /api/admin/merchants` — list merchants, auto-scoped to the acting
  admin's own country (Owner / Global Super Admin see all). Requires
  `merchant:view`.
- `GET /api/admin/merchants/:id` — fetch one merchant (country-scoped).
  Requires `merchant:view`.
- `POST /api/admin/merchants` — create a merchant (name + countryId
  required; starts in `pending` status). Requires `merchant:manage`.
- `PUT /api/admin/merchants/:id` — edit name/contact/notes. Requires
  `merchant:manage`.
- `PUT /api/admin/merchants/:id/status` — move between
  `pending` / `active` / `suspended`. Requires `merchant:manage`.

Every write is audit-logged via the existing `rbac.logAction()`, same as
every other admin action in the project.

## Permissions used

`merchant:view` and `merchant:manage`, defined in `rbac.js`'s
`PERMISSIONS` list with default role grants that exactly mirror the
existing `agencies:view`/`agencies:manage` asymmetry: Country Manager
gets both (full manage within their own country), Admin gets `view`
only, Global Super Admin / Country Super Admin get both via the "all
except owner-only" default set, Owner is implicit-all as always.

## Country scoping

Depends on `country_permission` (must be attached first — `server.js`
does this in the correct order). Reuses its `registry.isValidCountry`,
`middleware.validateCountryBody`, `middleware.requireCountryScope`, and
`middleware.attachCountryFilter` rather than re-implementing any of them.

## Data

- Runtime store: `data/merchants.json` (own file, never shares or
  overwrites any existing data file).
- Optional Postgres mirror: `merchant_kv` table, inert unless
  `DATABASE_URL` is set.
- `migrations/001_merchant_extension.sql` — additive-only (`CREATE TABLE
  IF NOT EXISTS`), a proper relational `merchants` table for if/when this
  module moves off JSON, with a `country_id` FK into
  `country_permission`'s `country_config` table.

## Admin panel

A "Merchants" sidebar section exists in `admin/index.html`/`admin/app.js`,
gated by `SECTION_PERMISSIONS.merchants = "merchant:view"` in `rbac.js`,
mirroring the existing Agencies panel: create form, status controls,
country-scoped list.

## Tests

`node integration_update/merchant/test/merchant.test.js` — standalone
harness, no npm deps, exercises the real `country_permission` registry
(not a mock of it) alongside a mocked `rbac`. 14 assertions, all passing.

## Next stage

Per `integration_update/README.md`'s priority order, `call_hosting/` was
audited and found to already exist at the project root — see that
folder's README. Remaining open slots (`admin_updates/` beyond this
panel, `middleware/`, `config/`) have no concrete spec yet.
