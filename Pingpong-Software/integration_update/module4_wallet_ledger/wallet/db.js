// module4/wallet/db.js
// ==================================================
// MODULE 4 — STEP 4.4: WALLET POSTGRES CONNECTION
// ==================================================
// A standalone Postgres pool, independent of perf/dbPersistence.js's
// pool. This is a deliberate, disclosed duplication of *connection
// boilerplate* (not business logic) rather than a shared import,
// because sharing would mean this module requiring a file from the
// original project — breaking Module 4's isolation requirement. The
// safety-critical parts of the pattern (the 'error' listener below)
// are copied from perf/dbPersistence.js's proven approach on purpose,
// not reinvented. At merge time these two pools can be unified into
// one if desired — noted in the Step 4.4 report as a merge-time
// cleanup, not required for Module 4 to be correct standalone.
//
// WHY THE 'error' LISTENER MATTERS (same reasoning as
// perf/dbPersistence.js): pg's Pool emits an 'error' event for any
// idle client's background failure (dropped connection, DB restart,
// network blip). An unlistened 'error' event is treated by Node as
// fatal and kills the whole process. Every pool this module creates
// gets this listener before anything else touches it.
//
// SAFETY CONTRACT: if DATABASE_URL is not set, or 'pg' is not
// installed, or the pool fails to construct, every function here
// degrades to returning null/throwing a clearly-labeled "wallet
// durability layer not configured" error rather than silently
// pretending to succeed — this is the one place in Module 4 where
// silent no-op would be actively dangerous (money), so unlike
// routing.js/roomState.js's "return null and carry on" contract,
// wallet writes FAIL LOUDLY when Postgres isn't available. A cache/
// coordination layer (Redis) is allowed to be soft-optional; the
// ledger is not.

const DATABASE_URL = process.env.MODULE4_WALLET_DATABASE_URL || process.env.DATABASE_URL || "";

let PoolCtor = null;
try {
    PoolCtor = require("pg").Pool;
} catch (e) {
    PoolCtor = null;
}

let pool = null;
let schemaEnsured = false;

// Accepts an injected pool for testing (so this file's logic can be
// exercised without a real Postgres server or the 'pg' package
// installed) or for a caller that wants to supply its own pre-built
// pool at merge time instead of env-var configuration.
function configure(injectedPool) {
    if (injectedPool) {
        pool = injectedPool;
        return pool;
    }
    if (pool) return pool;
    if (!PoolCtor || !DATABASE_URL) return null;
    pool = new PoolCtor({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 30000,
        max: parseInt(process.env.MODULE4_WALLET_DB_POOL_MAX || "5", 10),
        ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });
    // See header comment — this listener is not optional.
    pool.on("error", (err) => {
        console.error(`[module4/wallet/db] idle client error (non-fatal, pool continues): ${err.message}`);
    });
    return pool;
}

function getPool() {
    return pool || configure();
}

function isEnabled() {
    return !!getPool();
}

const SCHEMA_SQL = require("fs").readFileSync(require("path").join(__dirname, "schema.sql"), "utf8");

// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS only. Safe to call on
// every boot. Callers should await this before the first wallet
// operation; index.js's init() does this automatically.
async function ensureSchema() {
    const p = getPool();
    if (!p) throw new Error("[module4/wallet/db] cannot ensure schema: Postgres not configured (set DATABASE_URL or MODULE4_WALLET_DATABASE_URL)");
    if (schemaEnsured) return;
    const client = await p.connect();
    try {
        await client.query(SCHEMA_SQL);
        schemaEnsured = true;
    } finally {
        client.release();
    }
}

async function shutdown() {
    if (pool) await pool.end().catch(() => {});
    pool = null;
    schemaEnsured = false;
}

module.exports = { configure, getPool, isEnabled, ensureSchema, shutdown };
