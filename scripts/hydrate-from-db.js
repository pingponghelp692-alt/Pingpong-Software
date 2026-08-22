// ==================================================
// PHASE 12 — BOOT-TIME HYDRATION FROM POSTGRES (additive, optional)
// ==================================================
// Runs ONCE, before server.js starts (see package.json's "start" script).
// server.js loads every data/*.json file synchronously and immediately at
// require-time (`let users = safeRead(USERS_FILE, {})` and ~20 more like
// it across server.js and the feature modules) — there is no safe place
// to make that async without restructuring startup order across the whole
// app, which the "no refactor" requirement rules out. Running this as a
// separate step BEFORE `node server.js` sidesteps that entirely: by the
// time server.js's own code runs, any files this script restored are
// already sitting on local disk exactly as if they'd never been wiped —
// safeRead()/safeWrite()/writeQueue.js need zero changes.
//
// Safety rule: this ONLY restores a file that is currently MISSING on
// local disk. If the file already exists (normal restart, disk survived,
// or DATABASE_URL isn't even configured), it is left completely alone —
// this script can never overwrite a fresher local copy with an older
// Postgres one, and the existing backup/atomic-write/recovery logic in
// server.js and writeQueue.js continues to be what actually protects that
// file at runtime.
//
// Always exits 0 (success), no matter what happens — a missing/misconfigured
// DATABASE_URL, an unreachable database, a missing 'pg' package, or any
// other error here must never prevent the real server from starting.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { resolveDataFolder } = require("../perf/dataFolder.js");
const db = require("../perf/dbPersistence.js");

async function main() {
    if (!db.isEnabled()) {
        console.log("ℹ️  DATABASE_URL not set — skipping Postgres hydration, using local JSON files as-is.");
        return;
    }
    const DATA_FOLDER = resolveDataFolder(path.join(__dirname, ".."));
    fs.mkdirSync(DATA_FOLDER, { recursive: true });

    const rows = await db.listAll();
    if (!rows.length) {
        console.log("ℹ️  Postgres backstop has no saved data yet (first run) — using local JSON files as-is.");
        return;
    }

    let restored = 0;
    for (const row of rows) {
        const filePath = path.join(DATA_FOLDER, row.key);
        if (fs.existsSync(filePath)) continue; // never clobber a file that's already there
        try {
            // Validate before trusting: every file this app persists is a
            // JSON object or array (users.json, rooms.json, etc.) — never
            // a bare string/number/null. A row that fails this basic shape
            // check is more likely a corrupt/partial Postgres write than
            // real data; abort restoring THIS file (server.js's own
            // safeRead()/{} default takes over) instead of writing garbage
            // to local disk and letting it look like real user data.
            if (row.value === null || typeof row.value !== "object") {
                console.error(`🐘 Skipping restore of ${row.key} — Postgres value is not a valid object/array (looks corrupt). Server will start with local default for this file.`);
                continue;
            }
            const tmp = filePath + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(row.value, null, 2));
            // Re-read + re-parse what was just written as a final sanity
            // check before it goes live under the real filename.
            JSON.parse(fs.readFileSync(tmp, "utf8"));
            fs.renameSync(tmp, filePath);
            restored++;
            console.log(`🐘 Restored ${row.key} from Postgres (missing on local disk).`);
        } catch (err) {
            console.error(`🐘 Could not restore ${row.key} from Postgres — server will start with whatever local file/default exists:`, err.message);
        }
    }
    console.log(restored ? `✅ Hydration complete — ${restored} file(s) restored from Postgres.` : "ℹ️  All expected JSON files already present locally — nothing to restore.");
}

main()
    .catch((err) => console.error("🐘 Hydration step failed (continuing to start the server on local JSON files):", err.message))
    .finally(async () => {
        await db.closePool();
        process.exit(0); // ALWAYS succeed so package.json's `&&` proceeds to `node server.js`
    });
