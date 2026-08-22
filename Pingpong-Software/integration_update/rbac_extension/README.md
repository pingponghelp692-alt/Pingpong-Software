# RBAC Extension

**Built.** Deliberately small and targeted: adds exactly the permission
strings that earlier stages of this package (`merchant/`) were built
without, per `country_permission/README.md`'s design principle 4
("genuinely new permission strings are deferred to the rbac_extension/
stage"). Does not touch anything about the existing RBAC model's shape —
`rbac.js`'s `PERMISSIONS` array, `DEFAULT_ROLE_PERMISSIONS`, and
`SECTION_PERMISSIONS` are all additive-only structures; this stage adds
entries, never removes or renames any existing one.

## What was added, and why

Auditing the main app's own RBAC conventions (not this package's) showed
every existing feature — agencies, gifts, vip, recharge, withdraw,
frames, namefx, ban — gates reads behind a dedicated `:view` permission.
`merchant/`'s first cut (built before this stage existed) didn't have
real permissions to use yet, so it borrowed `agencies:manage` for writes
and left reads ungated — explicitly flagged in that revision as a
placeholder. This stage fixes that:

- **`merchant:view`** — added to `PERMISSIONS`. Granted by default to
  Country Manager and Admin (mirrors `agencies:view`'s grant pattern).
  Gates `GET /api/admin/merchants` and `GET /api/admin/merchants/:id`.
- **`merchant:manage`** — added to `PERMISSIONS`. Granted by default to
  Country Manager only, NOT Admin (mirrors the existing
  `agencies:view`+`agencies:manage` asymmetry, where Admin can view but
  not approve/manage). Gates the create/update/status-change routes.
- **`SECTION_PERMISSIONS.merchants` → `merchant:view`** — so a future
  admin-panel sidebar entry for Merchants can reuse the exact same
  visibility mechanism every other section already uses (see
  `admin_updates/`).

Owner and Global Super Admin / Country Super Admin need no explicit
grant — the existing `ALL_EXCEPT_OWNER_ONLY` computed set (and Owner's
implicit all-permissions rule) picks up any newly added permission
automatically, same as every other permission already in the file.

## Migration note (existing admin accounts)

`rbac.js`'s `effectivePermissions()` falls back to
`DEFAULT_ROLE_PERMISSIONS[role]` only for admin accounts that have no
persisted custom `permissions` override. Any admin account with a custom
grant list will **not** automatically receive `merchant:view`/
`merchant:manage` — same as every other permission ever added to this
file; a Country Manager (or Admin) with a custom permission set needs a
manual re-grant via the existing role-management UI, exactly as would be
true for any previously added permission. This was verified against the
real `rbac.js` module (not a mock) before shipping — see below.

## Changes to `merchant/`

`registry.js` now exports `VIEW_PERMISSION`/`WRITE_PERMISSION` as
`"merchant:view"`/`"merchant:manage"` instead of borrowing
`agencies:manage`. `routes.js`'s two GET routes now also require
`merchant:view`. `test/merchant.test.js` updated to match.

## Verification

- Instantiated the real `rbac.js` module (via its `makeStore()` factory,
  not a mock) and confirmed: both permissions exist in `PERMISSIONS`;
  Country Manager's default set includes both; Admin's includes only
  `merchant:view`; Global Super Admin auto-includes both; Moderator is
  unaffected; `SECTION_PERMISSIONS.merchants` resolves correctly.
- `merchant.test.js`: 14/14 passing with the new permission strings.
- `server.js` and all 90 project JS files re-verified with `node --check`
  after this change.
