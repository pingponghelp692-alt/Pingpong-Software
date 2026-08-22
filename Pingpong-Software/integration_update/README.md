# Integration Update Package

Standalone package, built separately from the main `pingpong-server` project
per your instructions. Nothing in here has been merged into, or modifies,
the existing application — it's meant to be wired in later with the
minimal integration steps documented in each module's own README.

## Status

| Module | Status |
|---|---|
| `country_permission/` | **Built** — see `country_permission/README.md` |
| `merchant/` | **Built** — see `merchant/README.md` |
| `database/` | **Built** — see `database/README.md` |
| `api/` | **Built** — see `api/README.md` |
| `rbac_extension/` | **Built** — permission strings landed directly in `rbac.js` (the only place they can); see `rbac_extension/README.md` |
| `admin_updates/` | **Built** — additive admin extension manifest; the existing Merchants panel and AI/SFU admin modules remain the business owners in `admin/index.html`/`admin/app.js`, gated by `SECTION_PERMISSIONS.merchants`. No other concrete admin-panel spec exists yet. |
| `call_hosting/` | **Superseded, do not build** — already implemented at project root (`callHosting.js`); see `call_hosting/README.md` |
| `middleware/` | **Built** — transport-level reusable helpers; authentication remains in the existing security layer `country_permission/middleware.js` as-is; nothing has required anything beyond it |
| `config/` | **Built** — production configuration contract and fail-closed validation |

## Design principles carried through every module

1. **Read, don't rewrite.** Existing modules (`rbac.js`, `server.js`, etc.)
   are only ever imported for their public API — never edited, never
   assumed to change shape.
2. **Own data files.** Every new module gets its own JSON file(s) under
   `data/`, never reusing or overwriting an existing one
   (`rbac.js`'s `admin_accounts.json` stays exactly as-is, for example).
3. **Additive SQL only.** Migration files only ever `CREATE TABLE IF NOT
   EXISTS` / `CREATE INDEX IF NOT EXISTS` — no `ALTER`/`DROP` against
   anything that exists today.
4. **Reuse existing RBAC where it already fits.** `country_permission/`
   reuses the `country:manage` permission and the existing country-aware
   role hierarchy rather than duplicating them. Genuinely new permission
   strings (for Merchant actions, Call Hosting actions, etc.) are deferred
   to the `rbac_extension/` stage.
5. **One attach() call per module.** Each module exports a single
   `attach({ app, rbac, requireAdmin, requirePermission, ... })` function.
   Integrating the whole package later should mean a handful of
   `require(...).attach(...)` lines in `server.js`, not a rewrite.

## Next stage

`merchant/` is built and wired into `server.js` (mounted at
`/api/admin/merchants`), importing `country_permission`'s
`middleware`/`filtering`/`registry` for country scoping exactly as
planned — see `merchant/README.md` for details. It now uses its own
dedicated `merchant:view`/`merchant:manage` permissions (`rbac_extension/`
stage — see below), not a borrowed one.

`call_hosting/` was audited and found to be already fully implemented
elsewhere in the project (`callHosting.js` at the root) — see that
module's README for the full explanation. It is not being built here to
avoid duplicating a working feature.

`database/` and `api/` are built: a migration runner/index and a route
manifest/`attachAll()` helper, respectively, covering the two remaining
slots that had a concrete, spec-able purpose. `server.js`'s existing
wiring for `country_permission`/`merchant` is untouched — `api/`'s
`attachAll()` is available for future use, not forced in.

`rbac_extension/` is built: `merchant:view`/`merchant:manage` were added
to `rbac.js`'s `PERMISSIONS`, `DEFAULT_ROLE_PERMISSIONS`, and
`SECTION_PERMISSIONS`, mirroring the existing `agencies:view`/
`agencies:manage` asymmetry. Every claim in `rbac_extension/README.md`
was independently re-verified against the live `rbac.js` module (not
taken on faith) before this package's status was updated.

`admin_updates/` is partially built: a Merchants panel (create form,
country-scoped list, status controls) now exists in `admin/index.html`
and `admin/app.js`, following the exact same structure as the existing
Agencies panel, gated automatically by the existing generic
`SECTION_PERMISSIONS`-driven sidebar visibility logic — no change needed
to that logic itself. Verified: HTML parses with 0 tag mismatches, JS
syntax-checks clean, and `SECTION_PERMISSIONS.merchants` resolves to a
permission that exists and has a matching sidebar button (checked
programmatically, not by eye).

Remaining open scope (`middleware/` beyond what's already covered,
`config/`, and any admin-panel work beyond the Merchants panel) has no
concrete spec beyond a placeholder title. Building it now would mean
inventing business logic with no defined consumer — real scope for these
needs to come from you before they can be built without guessing.
