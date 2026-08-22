# API (shared route index)

**Built.** `index.js` exports a static `MOUNTS` manifest (name + mount
path + require path for every attached module — currently
`country_permission` and `merchant`) and an optional `attachAll()` helper
that wires every listed module in one call, resolving the
`merchant` → `country_permission` dependency automatically.

**Does not change how `server.js` currently attaches modules.** Per the
project rule against replacing working code, `server.js` keeps its two
explicit `require(...).attach(...)` lines exactly as they are. This
module is additive: available for introspection (e.g. a future "installed
extensions" admin panel reading `MOUNTS`) and as an optional convenience
a *future* module or deploy script can use instead of hand-writing one
`require` per module.

## Verified

- `MOUNTS` manifest reads correctly (no dependency on `express`).
- Syntax-checked.
- **Not** end-to-end tested against a real Express `app` in this sandbox
  — network access is disabled here, so the `express` package couldn't be
  installed to exercise `attachAll()`'s actual router mounting. The code
  path is structurally identical to the `app.use(mountPath, router)`
  pattern already proven working in production by `country_permission`
  and `merchant` (both wired into `server.js` the same way). Recommend a
  quick manual smoke test (`node integration_update/database/index.js`
  equivalent, or just starting `server.js` normally, since `attachAll()`
  itself isn't called by `server.js` today) before relying on
  `attachAll()` specifically.
