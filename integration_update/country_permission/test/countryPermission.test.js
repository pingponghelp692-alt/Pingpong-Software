// countryPermission.test.js
// Standalone verification harness — no npm deps, mocks a minimal rbac
// instance (same shape as the real rbac.js public API) so this exercises
// the real module logic. Run: node test/countryPermission.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeRegistry } = require("../countryRegistry");
const { makeMiddleware } = require("../middleware");
const filtering = require("../filtering");

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---- minimal mock of rbac.js's public API ----
const ROLES = { OWNER: "owner", GLOBAL_SUPER_ADMIN: "global_super_admin", COUNTRY_MANAGER: "country_manager" };
const COUNTRIES = [{ id: "IN", name: "India", superAdminSlots: 2, adminSlots: 6 }, { id: "BD", name: "Bangladesh", superAdminSlots: 2, adminSlots: 6 }];
function makeMockRbac() {
    const auditLog = [];
    return {
        ROLES,
        COUNTRIES,
        COUNTRY_IDS: COUNTRIES.map((c) => c.id),
        inScope(actor, countryId) {
            if (!actor) return false;
            if (actor.role === ROLES.OWNER || actor.role === ROLES.GLOBAL_SUPER_ADMIN) return true;
            if (!countryId) return true;
            return actor.countryId === countryId;
        },
        hasPermission(actor, permission) {
            if (actor.role === ROLES.OWNER) return true;
            return (actor.permissions || []).includes(permission);
        },
        logAction(entry) { auditLog.push(entry); },
        _auditLog: auditLog
    };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "country-permission-test-"));
const rbac = makeMockRbac();
const registry = makeRegistry({ rbac, dataFolder: tmpDir });
const middleware = makeMiddleware({ rbac, registry });

const owner = { id: "owner-1", role: ROLES.OWNER, countryId: null, permissions: [] };
const countryManagerIN = { id: "cm-in", role: ROLES.COUNTRY_MANAGER, countryId: "IN", permissions: ["country:manage"] };
const countryManagerBD = { id: "cm-bd", role: ROLES.COUNTRY_MANAGER, countryId: "BD", permissions: [] };

console.log("Country Permission — verification\n");

// isValidCountry
assert(registry.isValidCountry("IN") === true, "IN is a valid country");
assert(registry.isValidCountry("ZZ") === false, "ZZ is not a valid country");

// listCountries scoping
assert(registry.listCountries(owner).length === 2, "Owner sees all countries");
assert(registry.listCountries(countryManagerIN).length === 1 && registry.listCountries(countryManagerIN)[0].id === "IN",
    "Country Manager only sees their own country");

// default enabled
assert(registry.describe("IN").enabled === true, "Country defaults to enabled with no config yet");

// updateCountryConfig: permission required
const denied = registry.updateCountryConfig(countryManagerBD, "BD", { enabled: false });
assert(denied.success === false, "updateCountryConfig denied without country:manage permission");

// updateCountryConfig: happy path + persisted
const updated = registry.updateCountryConfig(countryManagerIN, "IN", { enabled: false, currency: "INR" });
assert(updated.success === true, "updateCountryConfig succeeds with permission");
assert(registry.describe("IN").enabled === false, "Disabled flag persisted");
assert(registry.describe("IN").currency === "INR", "Currency persisted");
assert(rbac._auditLog.some((e) => e.action === "country-config-update"), "Config change was audit-logged via rbac.logAction");

// middleware.requireCountryScope
function mockReqRes(actor, countryId) {
    let statusCode = null, body = null, nextCalled = false;
    const req = { adminAccount: actor };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; } };
    middleware.requireCountryScope(() => countryId)(req, res, () => { nextCalled = true; });
    return { nextCalled, statusCode, body };
}
assert(mockReqRes(countryManagerIN, "IN").nextCalled === true, "In-scope country passes middleware");
assert(mockReqRes(countryManagerIN, "BD").nextCalled === false, "Out-of-scope country is blocked");
assert(mockReqRes(owner, "BD").nextCalled === true, "Owner passes for any country");

// filtering.filterByCountry
const rows = [{ id: 1, countryId: "IN" }, { id: 2, countryId: "BD" }];
assert(filtering.filterByCountry(rows, { countryScope: "IN" }).length === 1, "filterByCountry narrows to scope");
assert(filtering.filterByCountry(rows, { countryScope: null }).length === 2, "filterByCountry passes through for global scope");

// filtering.scopeSqlWhere
const scoped = filtering.scopeSqlWhere({ countryScope: "IN" }, "country_id", []);
assert(scoped.clause === " AND country_id = $1" && scoped.params[0] === "IN", "scopeSqlWhere builds a bound clause for scoped actor");
const global = filtering.scopeSqlWhere({ countryScope: null }, "country_id", []);
assert(global.clause === "" && global.params.length === 0, "scopeSqlWhere is a no-op for global actor");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
