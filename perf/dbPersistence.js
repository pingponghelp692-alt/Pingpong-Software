// ==================================================
// PHASE 12 — POSTGRES DURABILITY BACKSTOP (additive, optional)
// ==================================================
// The problem this fixes: on Render (and most PaaS free/standard web
// services), the local filesystem is EPHEMERAL — every redeploy/restart
// gives the process a fresh disk, silently wiping data/*.json (users,
// rooms, coins, frames, vehicles, everything). No amount of atomic-write/
// backup-file code (writeQueue.js already does that correctly) can fix
// this, because the whole disk is replaced, not corrupted.
//
// The fix, scoped as narrowly as possible:
//   1. hydrateFromDb() — called ONCE per file, at process boot, BEFORE the
//      app's existing safeRead() ever runs (see scripts/hydrate-from-db.js).
//      Pulls the last known-good JSON blob for that file out of Postgres
//      and writes it to local disk. After this, safeRead()/safeWrite()/
//      writeQueue.js run completely unchanged — they don't know or care
//      whether the file they're reading was there all along or was just
//      restored. Zero changes to any of the 70+ existing safeRead/
//      safeWrite call sites across this codebase.
//   2. mirrorWrite() — called from writeQueue.js right after its existing
//      local atomic write already succeeds. Fire-and-forget: never
//      awaited, never throws, and a slow/unreachable database can only
//      ever delay this background mirror — it can never block or crash
//      the save that triggered it. The local JSON file remains the one
//      and only synchronous source of truth at runtime, exactly as today.
//
// Completely inert if DATABASE_URL is not set (default for every existing
// deployment) — 'pg' is not even require()'d in that case, so a
// deployment that never installs/configures Postgres is byte-for-byte
// today's behavior.

const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const ENABLED = !!DATABASE_URL;
const TABLE = "app_json_store";

let pool = null;
let initPromise = null;

function getPool() {
    if (!ENABLED) return null;
    if (pool) return pool;
    try {
        const { Pool } = require("pg");
        pool = new Pool({
            connectionString: DATABASE_URL,
            connectionTimeoutMillis: 8000,
            idleTimeoutMillis: 30000,
            max: 5,
            ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
        });
        // CRITICAL: pg's Pool emits an 'error' event for any idle client's
        // background failure (dropped connection, DB restart, network
        // blip). If nothing is listening, Node treats that as an
        // unhandled 'error' event and kills the ENTIRE process — this is
        // the single most common way adding Postgres to a Node app
        // introduces a brand-new crash that wasn't there before. Matches
        // this project's existing uncaughtException/unhandledRejection
        // philosophy at the top of server.js: log and keep running.
        pool.on("error", (err) => {
            console.error("🐘 Postgres pool error (server kept running, JSON files remain source of truth):", err.message);
        });
    } catch (err) {
        console.error("🐘 'pg' package not available — Postgres backstop disabled, continuing on JSON-only persistence:", err.message);
        pool = null;
    }
    return pool;
}

async function withRetry(fn, attempts = 3, baseDelayMs = 300) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
        }
    }
    throw lastErr;
}

function ensureTable() {
    const p = getPool();
    if (!p) return Promise.resolve(false);
    if (initPromise) return initPromise;
    initPromise = withRetry(() => p.query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
    )).then(() => true)
      .catch((err) => {
          console.error("🐘 Postgres init failed — continuing on JSON-only persistence:", err.message);
          initPromise = null; // allow a later call (e.g. next write) to retry once the DB recovers
          return false;
      });
    return initPromise;
}

function keyFor(filePath) { return path.basename(filePath); }

/**
 * Startup-only restore. If DATABASE_URL is configured and reachable, and a
 * row exists for this file, writes that JSON blob to `filePath` on local
 * disk (atomic temp-file-then-rename, same convention as writeQueue.js).
 * Returns true if it restored something, false otherwise (including: DB
 * disabled, unreachable, no row yet, or already-existing local file — see
 * scripts/hydrate-from-db.js, which only calls this for MISSING files so a
 * healthy local disk on a normal restart is never overwritten).
 */
async function hydrateFromDb(filePath) {
    if (!ENABLED) return false;
    const okInit = await ensureTable();
    if (!okInit) return false;
    const p = getPool();
    try {
        const result = await withRetry(() => p.query(`SELECT value FROM ${TABLE} WHERE key = $1`, [keyFor(filePath)]), 2, 300);
        if (!result.rows.length) return false;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(result.rows[0].value, null, 2));
        fs.renameSync(tmp, filePath);
        return true;
    } catch (err) {
        console.error(`🐘 Postgres restore failed for ${keyFor(filePath)} — starting from local file/backup instead:`, err.message);
        return false;
    }
}

/**
 * Background mirror of a JSON write into Postgres. Fire-and-forget: the
 * caller (writeQueue.js) never awaits this and its own local write has
 * already completed successfully before this is even called.
 */
function mirrorWrite(filePath, data) {
    if (!ENABLED) return;
    ensureTable().then((okInit) => {
        if (!okInit) return;
        const p = getPool();
        withRetry(() => p.query(
            `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [keyFor(filePath), JSON.stringify(data)]
        )).catch((err) => {
            console.error(`🐘 Postgres mirror write failed for ${keyFor(filePath)} (local JSON file is still current and unaffected):`, err.message);
        });
    });
}

/** All rows currently in Postgres — used only by the boot-time hydrate script. */
async function listAll() {
    if (!ENABLED) return [];
    const okInit = await ensureTable();
    if (!okInit) return [];
    const p = getPool();
    try {
        const result = await withRetry(() => p.query(`SELECT key, value FROM ${TABLE}`));
        return result.rows;
    } catch (err) {
        console.error("🐘 Postgres listAll failed — continuing on JSON-only persistence:", err.message);
        return [];
    }
}

async function closePool() {
    if (pool) { try { await pool.end(); } catch (_) {} }
}

module.exports = { isEnabled: () => ENABLED, hydrateFromDb, mirrorWrite, listAll, closePool };
