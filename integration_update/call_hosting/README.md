# Call Hosting + Paid Calling

**Superseded — do not build.** This slot was reserved before an audit of
the current codebase (2026-08-07) found that Call Hosting + Paid Calling
is already fully implemented at the project root, in `callHosting.js`
(host approval workflow, server-authoritative per-minute billing, rates,
reports, revenue ledger, and country scoping via the existing
`actorCanAccessCountry`/`countryDeniedResponse` helpers — see that file's
own header comment for the full design).

Building a second implementation here would duplicate a working,
already-scoped feature — exactly what this package's own design
principles (and the rest of the codebase's "no second engine" convention,
e.g. `approvalEngine.js`) exist to prevent. Left in place only so this
slot in the layout doesn't get silently reused for something else without
this note being read first.

If a genuine gap is ever found in the existing `callHosting.js` (e.g. it
needs to additionally validate against `country_permission`'s per-country
`enabled` flag, which it currently doesn't check), that's a small,
additive patch to `callHosting.js` itself — not a new module here.
