/* ==========================================================================
   Database — Shared Migration Index
   ==========================================================================
   Exactly what integration_update/database/README.md's placeholder
   described: "shared migration index across modules." Does not define
   any new tables itself — just discovers and (optionally) runs every
   migrations SQL file belonging to each integration_update submodule, in
   a stable, dependency-safe order, so operators don't have to hunt down
   and manually run each module's migration file one at a time.

   Ordering: alphabetical by module folder name, EXCEPT country_permission
   is always first — merchant's migration has a foreign key into
   country_permission's country_config table, and any future module here
   is expected to follow the same "country_permission first" convention
   documented in country_permission/README.md. If a future module doesn't
   depend on country_permission, alphabetical order is still safe for it
   since every statement in every migration is `CREATE ... IF NOT EXISTS`.

   Never runs automatically on require() — this is inert until something
   explicitly calls run(). Nothing in server.js currently calls this;
   operators run it manually (see below) or a future deploy script can
   wire it in.

   Usage (manual):
       node integration_update/database/index.js
       # or, to only list what would run without executing:
       node integration_update/database/index.js --dry-run

   Usage (programmatic):
       const { listMigrations, run } = require("./integration_update/database");
       await run({ databaseUrl: process.env.DATABASE_URL });
   ========================================================================== */

const fs = require("fs");
const path = require("path");

const PACKAGE_ROOT = path.join(__dirname, "..");
// country_permission is listed explicitly first because later modules'
// migrations may reference its tables (see merchant's FK into
// country_config). Everything else is discovered and sorted
// alphabetically — safe because every migration statement here is
// additive/idempotent (CREATE ... IF NOT EXISTS).
const PRIORITY_ORDER = ["country_permission"];

function discoverModules() {
    return fs.readdirSync(PACKAGE_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => fs.existsSync(path.join(PACKAGE_ROOT, name, "migrations")));
}

function listMigrations() {
    const modules = discoverModules();
    const ordered = [
        ...PRIORITY_ORDER.filter((m) => modules.includes(m)),
        ...modules.filter((m) => !PRIORITY_ORDER.includes(m)).sort()
    ];
    const files = [];
    for (const mod of ordered) {
        const dir = path.join(PACKAGE_ROOT, mod, "migrations");
        const sqlFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
        for (const f of sqlFiles) {
            files.push({ module: mod, file: f, fullPath: path.join(dir, f) });
        }
    }
    return files;
}

// Runs every discovered migration file, in order, against DATABASE_URL.
// Each file is expected to be safe to run multiple times (every existing
// migration in this package uses CREATE TABLE/INDEX IF NOT EXISTS only —
// this runner does not enforce that, it trusts the same additive-only
// convention every module's own migration file already documents).
async function run({ databaseUrl } = {}) {
    const DATABASE_URL = databaseUrl || process.env.DATABASE_URL || "";
    if (!DATABASE_URL) {
        console.log("[database] DATABASE_URL not set — nothing to do (JSON stores remain source of truth).");
        return { ran: [], skipped: true };
    }
    const { Pool } = require("pg");
    const pool = new Pool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 8000,
        ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
    });
    const migrations = listMigrations();
    const ran = [];
    try {
        for (const m of migrations) {
            const sql = fs.readFileSync(m.fullPath, "utf8");
            console.log(`[database] running ${m.module}/${m.file} ...`);
            await pool.query(sql);
            ran.push(`${m.module}/${m.file}`);
        }
    } finally {
        await pool.end();
    }
    console.log(`[database] done — ${ran.length} migration file(s) applied.`);
    return { ran, skipped: false };
}

if (require.main === module) {
    const dryRun = process.argv.includes("--dry-run");
    if (dryRun) {
        const migrations = listMigrations();
        console.log(`[database] ${migrations.length} migration file(s) would run, in order:`);
        migrations.forEach((m, i) => console.log(`  ${i + 1}. ${m.module}/${m.file}`));
    } else {
        run().catch((err) => {
            console.error("[database] migration run failed:", err.message);
            process.exit(1);
        });
    }
}

module.exports = { listMigrations, run };
