// scripts/wallet-opening-balance-migration.js
//
// PRODUCTION AUDIT DELIVERABLE (2026-08-10) — see WALLET_CUTOVER_PLAN.md
// for the full plan this script implements Stage 2 of.
//
// Purpose: seed Module 4's Postgres ledger (module4_wallet_ledger /
// module4_wallet_balances) with an OPENING BALANCE entry per user per
// currency, taken from the live legacy source of truth (data/users.json's
// .coins / .diamonds fields) — WITHOUT touching, reading destructively,
// or mutating that legacy file in any way. This is purely additive: it
// only ever writes into Module 4's own tables.
//
// It does NOT flip MODULE4_WALLET_ENABLED, does NOT rewire any of the
// ~25 legacy mutation call sites (see WALLET_CUTOVER_PLAN.md's traced
// list), and does NOT run automatically from npm start/CI. Per the
// project's own module4_wallet_ledger/index.js header and the audit
// brief's explicit instruction, that cutover requires a separate,
// explicit, human-approved stage — this script only prepares data for it.
//
// SAFETY PROPERTIES:
//   - Idempotent: txnId for each opening-balance row is deterministic
//     (`opening-balance:<userId>:<currency>`), so re-running this script
//     after a partial failure or after new users signed up simply skips
//     users who already have an opening-balance row (checked via
//     getTransaction()) and seeds only the new ones. Never double-credits.
//   - Read-only against legacy data: only requires data/users.json, never
//     writes to it.
//   - Dry-run by default. Requires --execute to actually write anything.
//   - Every run produces a JSON report (migration-report-<timestamp>.json)
//     in the current directory for audit trail / rollback reference.
//
// USAGE:
//   node scripts/wallet-opening-balance-migration.js                  # dry-run, prints plan only
//   node scripts/wallet-opening-balance-migration.js --execute        # actually writes to Postgres
//   node scripts/wallet-opening-balance-migration.js --execute --verify-only  # re-run reconciliation only
//
// PREREQUISITES (none of which this sandbox has — see EXTERNAL VALIDATION
// REQUIRED note in WALLET_CUTOVER_PLAN.md):
//   - MODULE4_WALLET_DATABASE_URL pointing at a real, migrated Postgres
//     instance (run the SQL in integration_update/module4_wallet_ledger/
//     migrations/ and wallet/schema.sql first).
//   - Run against a STAGING copy of data/users.json first. Never point
//     --execute at production data without having done a staging dry run
//     and a --verify-only pass first.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const USERS_FILE = path.join(ROOT, "data", "users.json");

function loadLegacyUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        throw new Error(`Legacy users file not found at ${USERS_FILE} — nothing to migrate from.`);
    }
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw);
}

function openingBalanceTxnId(userId, currency) {
    return `opening-balance:${userId}:${currency}`;
}

async function main() {
    const args = process.argv.slice(2);
    const execute = args.includes("--execute");
    const verifyOnly = args.includes("--verify-only");

    console.log("==================================================");
    console.log("Module 4 Wallet — Opening Balance Migration");
    console.log(`Mode: ${execute ? (verifyOnly ? "VERIFY-ONLY" : "EXECUTE (writes to Postgres)") : "DRY-RUN (no writes)"}`);
    console.log("==================================================\n");

    const legacyUsers = loadLegacyUsers();
    const userIds = Object.keys(legacyUsers);
    console.log(`Loaded ${userIds.length} users from legacy store: ${USERS_FILE}`);

    const plan = [];
    for (const userId of userIds) {
        const u = legacyUsers[userId];
        if (!u || typeof u !== "object") continue;
        const coins = Number.isFinite(u.coins) ? u.coins : 0;
        const diamonds = Number.isFinite(u.diamonds) ? u.diamonds : 0;
        if (coins > 0) plan.push({ userId, currency: "coins", amount: coins, txnId: openingBalanceTxnId(userId, "coins") });
        if (diamonds > 0) plan.push({ userId, currency: "diamonds", amount: diamonds, txnId: openingBalanceTxnId(userId, "diamonds") });
    }

    console.log(`Plan: ${plan.length} opening-balance entries (${plan.filter(p => p.currency === "coins").length} coins, ${plan.filter(p => p.currency === "diamonds").length} diamonds).`);
    console.log("Zero-balance users are skipped — Module 4's getBalance() already defaults an unseeded user to 0, so there's nothing to seed for them.\n");

    if (!execute) {
        console.log("DRY-RUN — no Postgres connection opened, nothing written.");
        console.log("Sample of first 5 planned entries:");
        console.log(JSON.stringify(plan.slice(0, 5), null, 2));
        console.log("\nRun again with --execute against a STAGING database to actually seed.");
        return;
    }

    if (!process.env.MODULE4_WALLET_DATABASE_URL) {
        throw new Error("--execute was passed but MODULE4_WALLET_DATABASE_URL is not set. Refusing to run against no configured database.");
    }

    // Only require these heavy deps when actually executing, so the
    // dry-run path above works even without `pg` installed.
    const { Pool } = require("pg");
    const wallet = require("../integration_update/module4_wallet_ledger/wallet/index.js");
    const pgPool = new Pool({ connectionString: process.env.MODULE4_WALLET_DATABASE_URL });

    await wallet.init({ pgPool });

    const report = { startedAt: new Date().toISOString(), mode: verifyOnly ? "verify-only" : "execute", results: [] };

    for (const entry of plan) {
        try {
            if (!verifyOnly) {
                // getTransaction() first — idempotency check, so a re-run
                // after a partial failure never double-credits a user who
                // already got their opening balance seeded.
                const existing = await wallet.getTransaction(entry.txnId);
                if (existing) {
                    report.results.push({ ...entry, status: "skipped-already-seeded" });
                    continue;
                }
                await wallet.credit({
                    userId: entry.userId,
                    currency: entry.currency,
                    amount: entry.amount,
                    txnId: entry.txnId,
                    reason: "opening-balance-migration",
                    context: { source: "legacy-users-json", migratedAt: new Date().toISOString() }
                });
            }
            // Reconcile every seeded (or previously seeded) user immediately —
            // this is the "verification" half of Section 7's requirement,
            // not a separate manual step.
            const recon = await wallet.reconcileBalance(entry.userId, entry.currency);
            const matches = recon.trueBalance === entry.amount;
            report.results.push({ ...entry, status: "reconciled", ledgerBalance: recon.trueBalance, expectedBalance: entry.amount, matches });
            if (!matches) {
                console.warn(`⚠️  MISMATCH for ${entry.userId}/${entry.currency}: expected ${entry.amount}, ledger has ${recon.trueBalance}`);
            }
        } catch (err) {
            report.results.push({ ...entry, status: "error", error: err.message });
            console.error(`✗ ${entry.userId}/${entry.currency}: ${err.message}`);
        }
    }

    report.finishedAt = new Date().toISOString();
    report.summary = {
        total: plan.length,
        reconciled: report.results.filter(r => r.status === "reconciled" && r.matches).length,
        mismatched: report.results.filter(r => r.status === "reconciled" && !r.matches).length,
        skipped: report.results.filter(r => r.status === "skipped-already-seeded").length,
        errors: report.results.filter(r => r.status === "error").length
    };

    const reportFile = path.join(ROOT, `migration-report-${Date.now()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    console.log("\n==================================================");
    console.log("Summary:", JSON.stringify(report.summary, null, 2));
    console.log(`Full report written to: ${reportFile}`);
    console.log("==================================================");

    await wallet.shutdown();
    await pgPool.end();

    if (report.summary.errors > 0 || report.summary.mismatched > 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Migration script failed:", err.message);
    process.exitCode = 1;
});
