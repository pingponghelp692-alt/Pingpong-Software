// scripts/coin-to-diamond-migration.js
//
// PHASE A of the Coin→Diamond currency migration (2026-08-21).
// Converts every user's current `coins` balance in the LEGACY flat-file
// store (data/users.json — still the live source of truth; see
// wallet-opening-balance-migration.js's header for why Module 4/Postgres
// is a separate, not-yet-cut-over system this script does NOT touch) into
// `diamonds` at a fixed 3:1 rate (3 coins = 1 diamond), then zeroes the
// `coins` balance. This is Phase A only — it does NOT remove the `coins`
// field, does NOT touch recharge/gift-pricing/coin-seller/game-economy
// code (Phases B–E), and does NOT delete anything irreversibly.
//
// RATE: 3 coins = 1 diamond (confirmed by product owner 2026-08-21).
//   diamondsToAdd = Math.floor(coins / 3)
//   remainder     = coins % 3   (see REMAINDER POLICY below)
//
// REMAINDER POLICY: a coin balance not evenly divisible by 3 leaves a
// remainder of 1 or 2 coins that cannot be converted at this rate. This
// script does NOT silently discard it — the remainder is left sitting in
// `coins` (not zeroed) and flagged per-user in the report as
// `remainderCoins`, so a human decides what to do with it (top it up to
// the next diamond, refund, or intentionally drop it) rather than this
// script making that call quietly. Re-running after that decision is
// safe (see idempotency below).
//
// SAFETY PROPERTIES (mirrors wallet-opening-balance-migration.js):
//   - Dry-run by default. Requires --execute to actually write anything.
//   - Idempotent: a user already migrated (has a transaction with txnId
//     `coin-diamond-migration:<userId>`) is skipped on re-run, never
//     double-converted.
//   - Writes timestamped .bak copies of users.json + transactions.json
//     into data/ before touching either file.
//   - Every run (dry-run or execute) produces a JSON report
//     (coin-diamond-migration-report-<timestamp>.json in the project
//     root) with a full per-user breakdown for audit / manual review.
//   - Every conversion is also logged as a normal transaction entry
//     (currency: "diamonds", note: "coin-to-diamond-migration") using
//     the exact same shape logTransaction() writes in server.js, so it
//     shows up in existing admin transaction-history views with no
//     admin-panel changes needed.
//
// PREREQUISITES / HOW TO RUN (Termux):
//   1. STOP the running server first (`pm2 stop pingpong` or kill the
//      node process). This script writes users.json/transactions.json
//      directly — running it while the live server's debounced
//      writeQueue is also writing to those same files is a race
//      condition and can lose data. Do not run this against a live server.
//   2. node src/scripts/coin-to-diamond-migration.js
//        → DRY RUN: prints the full plan, writes nothing, still writes
//          the JSON report (so you can review it before deciding).
//   3. Review the report. Once satisfied:
//      node src/scripts/coin-to-diamond-migration.js --execute
//   4. Restart the server.
//
// This script intentionally does ONE thing (balance migration). Phases
// B–E (recharge, coin-seller module, gift pricing, game economy, and
// removing the coin UI/menus) are separate, reviewable changes — see the
// phase plan shared with the product owner on 2026-08-21.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveDataFolder } = require("../perf/dataFolder.js");

// server.js resolves DATA_FOLDER relative to ITS OWN __dirname (src/), not
// the project root — mirror that exactly (same pattern used by
// wallet-opening-balance-migration.js's ROOT) so this script points at the
// same data/ folder the live server actually reads/writes.
const SRC_DIR = path.join(__dirname, "..");
const DATA_FOLDER = resolveDataFolder(SRC_DIR);
const USERS_FILE = path.join(DATA_FOLDER, "users.json");
const TRANSACTIONS_FILE = path.join(DATA_FOLDER, "transactions.json");

const CONVERSION_RATE = 3; // 3 coins = 1 diamond

function migrationTxnId(userId) {
    return `coin-diamond-migration:${userId}`;
}

function loadJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function backupFile(file) {
    if (!fs.existsSync(file)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${file}.pre-coin-migration-${stamp}.bak`;
    fs.copyFileSync(file, dest);
    return dest;
}

function main() {
    const args = process.argv.slice(2);
    const execute = args.includes("--execute");

    console.log("==================================================");
    console.log("Coin → Diamond Balance Migration (Phase A)");
    console.log(`Rate: ${CONVERSION_RATE} coins = 1 diamond`);
    console.log(`Data folder: ${DATA_FOLDER}`);
    console.log(`Mode: ${execute ? "EXECUTE (writes users.json + transactions.json)" : "DRY-RUN (no writes, report only)"}`);
    console.log("==================================================\n");

    const users = loadJson(USERS_FILE, null);
    if (!users) throw new Error(`users.json not found at ${USERS_FILE} — nothing to migrate.`);
    const transactions = loadJson(TRANSACTIONS_FILE, []);
    // logTransaction() entries don't carry a `txnId` field with our custom
    // format — they use a random `id`. So idempotency is checked by `note`
    // + `userId` pair instead (unique enough for this one-time migration).
    const migratedUserIds = new Set(
        transactions.filter((t) => t.note === "coin-to-diamond-migration").map((t) => t.userId)
    );

    const mobiles = Object.keys(users);
    console.log(`Loaded ${mobiles.length} users from ${USERS_FILE}`);

    const plan = [];
    for (const mobile of mobiles) {
        const u = users[mobile];
        if (!u || typeof u !== "object" || !u.userId) continue;
        const coins = Number.isFinite(u.coins) ? u.coins : 0;
        if (coins <= 0) continue;
        if (migratedUserIds.has(u.userId)) {
            plan.push({ mobile, userId: u.userId, coins, status: "skipped-already-migrated" });
            continue;
        }
        const diamondsToAdd = Math.floor(coins / CONVERSION_RATE);
        const remainderCoins = coins % CONVERSION_RATE;
        plan.push({
            mobile, userId: u.userId,
            coinsBefore: coins, diamondsToAdd, remainderCoins,
            diamondsBefore: Number.isFinite(u.diamonds) ? u.diamonds : 0,
            status: "pending"
        });
    }

    const toMigrate = plan.filter((p) => p.status === "pending");
    const totalCoins = toMigrate.reduce((s, p) => s + p.coinsBefore, 0);
    const totalDiamonds = toMigrate.reduce((s, p) => s + p.diamondsToAdd, 0);
    const withRemainder = toMigrate.filter((p) => p.remainderCoins > 0);

    console.log(`Plan: ${toMigrate.length} users to migrate, ${plan.length - toMigrate.length} already migrated/skipped.`);
    console.log(`Total coins converting: ${totalCoins} → ${totalDiamonds} diamonds.`);
    console.log(`Users with a leftover remainder (1-2 coins, not convertible at this rate): ${withRemainder.length}\n`);

    const report = {
        startedAt: new Date().toISOString(),
        mode: execute ? "execute" : "dry-run",
        rate: `${CONVERSION_RATE} coins = 1 diamond`,
        summary: {
            totalUsersScanned: mobiles.length,
            usersWithCoinsAboveZero: plan.length,
            usersMigratedThisRun: 0, // filled in after the write loop below
            usersSkippedAlreadyMigrated: plan.length - toMigrate.length,
            usersWithRemainder: withRemainder.length,
            totalCoinsConverted: totalCoins,
            totalDiamondsAdded: totalDiamonds
        },
        entries: plan
    };

    if (!execute) {
        console.log("DRY-RUN — no files written.");
        console.log("Sample of first 5 planned entries:");
        console.log(JSON.stringify(toMigrate.slice(0, 5), null, 2));
        const reportFile = path.join(SRC_DIR, `coin-diamond-migration-report-${Date.now()}.json`);
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        console.log(`\nFull dry-run report written to: ${reportFile}`);
        console.log("Review it, then re-run with --execute to actually apply.");
        return;
    }

    // ---- EXECUTE ----
    const usersBackup = backupFile(USERS_FILE);
    const txnBackup = backupFile(TRANSACTIONS_FILE);
    console.log(`Backed up users.json -> ${usersBackup || "(no existing file)"}`);
    console.log(`Backed up transactions.json -> ${txnBackup || "(no existing file)"}`);

    let migratedCount = 0;
    for (const entry of toMigrate) {
        const u = users[entry.mobile];
        const diamondsAfter = (Number.isFinite(u.diamonds) ? u.diamonds : 0) + entry.diamondsToAdd;
        u.diamonds = diamondsAfter;
        // Leave the remainder (0-2 coins) in place; zero out only the
        // convertible portion. If remainderCoins is 0 this just sets
        // coins to 0.
        u.coins = entry.remainderCoins;

        // Same shape as server.js's logTransaction(), written directly
        // since this script runs standalone (server must be stopped).
        transactions.push({
            id: "txn_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex"),
            userId: entry.userId,
            currency: "diamonds",
            amount: entry.diamondsToAdd,
            balanceBefore: entry.diamondsBefore,
            balanceAfter: diamondsAfter,
            note: "coin-to-diamond-migration",
            status: "completed",
            time: new Date().toISOString()
        });
        entry.status = "migrated";
        migratedCount++;
    }

    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));

    report.summary.usersMigratedThisRun = migratedCount;
    report.finishedAt = new Date().toISOString();
    report.backups = { usersBackup, txnBackup };

    const reportFile = path.join(SRC_DIR, `coin-diamond-migration-report-${Date.now()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    console.log("\n==================================================");
    console.log(`Migrated ${migratedCount} users. ${totalDiamonds} diamonds added total.`);
    console.log(`Full report: ${reportFile}`);
    console.log("Restart the server now.");
    console.log("==================================================");
}

main();
