// merchant.test.js
// Standalone verification harness — no npm deps, mocks a minimal rbac
// instance (same shape as the real rbac.js public API, same mock style as
// country_permission's own test) plus a real country_permission instance
// built from the real countryRegistry, so this exercises real cross-module
// logic. Run: node test/merchant.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeRegistry: makeCountryRegistry } = require("../../country_permission/countryRegistry");
const { makeMiddleware: makeCountryMiddleware } = require("../../country_permission/middleware");
const countryFiltering = require("../../country_permission/filtering");
const { makeRegistry: makeMerchantRegistry } = require("../registry");

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

// ---- minimal mock of rbac.js's public API (same shape as country_permission's test) ----
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merchant-test-"));
const rbac = makeMockRbac();

// Real country_permission stack (not re-mocked) — exercises the actual
// cross-module dependency the same way server.js will use it.
const countryRegistry = makeCountryRegistry({ rbac, dataFolder: tmpDir });
const countryMiddleware = makeCountryMiddleware({ rbac, registry: countryRegistry });
const countryPermission = { registry: countryRegistry, middleware: countryMiddleware, filtering: countryFiltering };

const merchantRegistry = makeMerchantRegistry({ rbac, countryPermission, dataFolder: tmpDir });

const owner = { id: "owner-1", role: ROLES.OWNER, countryId: null, permissions: [] };
const managerIN = { id: "cm-in", role: ROLES.COUNTRY_MANAGER, countryId: "IN", permissions: ["merchant:view", "merchant:manage"] };
const managerBD = { id: "cm-bd", role: ROLES.COUNTRY_MANAGER, countryId: "BD", permissions: ["merchant:view"] };

console.log("Merchant — verification\n");

// create: permission required
const deniedCreate = merchantRegistry.createMerchant(managerBD, { name: "Acme Traders", countryId: "BD" });
assert(deniedCreate.success === false, "createMerchant denied without merchant:manage permission");

// create: invalid country rejected
const badCountry = merchantRegistry.createMerchant(managerIN, { name: "Acme Traders", countryId: "ZZ" });
assert(badCountry.success === false, "createMerchant rejects an unknown countryId");

// create: out-of-scope country rejected (IN manager trying to create a BD merchant)
const outOfScope = merchantRegistry.createMerchant(managerIN, { name: "Acme Traders", countryId: "BD" });
assert(outOfScope.success === false, "createMerchant rejects a country outside the actor's scope");

// create: happy path
const created = merchantRegistry.createMerchant(managerIN, { name: "Acme Traders", countryId: "IN", contact: "acme@example.com" });
assert(created.success === true, "createMerchant succeeds with permission, valid country, in scope");
assert(created.merchant.status === "pending", "New merchant defaults to pending status");
assert(rbac._auditLog.some((e) => e.action === "merchant-create"), "Creation was audit-logged via rbac.logAction");

const merchantId = created.merchant.id;

// listMerchants scoping
merchantRegistry.createMerchant(owner, { name: "Global Co", countryId: "BD" });
assert(merchantRegistry.listMerchants(owner).length === 2, "Owner sees all merchants");
assert(merchantRegistry.listMerchants(managerIN).length === 1 && merchantRegistry.listMerchants(managerIN)[0].countryId === "IN",
    "Country Manager only sees merchants in their own country");

// update: happy path
const updated = merchantRegistry.updateMerchant(managerIN, merchantId, { contact: "new@example.com" });
assert(updated.success === true, "updateMerchant succeeds with permission and in-scope record");
assert(merchantRegistry.describe(merchantId).contact === "new@example.com", "Updated contact persisted");

// update: out-of-scope blocked (BD manager, IN merchant — even though this
// specific mock grants managerBD no merchant:manage, prove the country
// check independently by using a country-scoped actor who DOES have the
// permission but the wrong country)
const managerBDWithPerm = { id: "cm-bd-2", role: ROLES.COUNTRY_MANAGER, countryId: "BD", permissions: ["merchant:view", "merchant:manage"] };
const blockedUpdate = merchantRegistry.updateMerchant(managerBDWithPerm, merchantId, { contact: "hacked@example.com" });
assert(blockedUpdate.success === false, "updateMerchant blocked for an out-of-scope country even with the write permission");

// setStatus: happy path + invalid status rejected
const statusChange = merchantRegistry.setStatus(managerIN, merchantId, "active");
assert(statusChange.success === true, "setStatus succeeds to a valid status");
assert(merchantRegistry.describe(merchantId).status === "active", "Status change persisted");
const badStatus = merchantRegistry.setStatus(managerIN, merchantId, "not-a-status");
assert(badStatus.success === false, "setStatus rejects an invalid status value");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
