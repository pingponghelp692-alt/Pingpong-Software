/* ==========================================================================
   Country Permission — Store
   ==========================================================================
   Flat-JSON source of truth for the *extension* config this module owns
   (per-country enabled flag, currency, timezone, future merchant/call-rate
   defaults). This is deliberately a SEPARATE file from rbac.js's own
   data/admin_accounts.json — nothing here reads or writes any existing
   data file, and rbac.js is never imported for its internals, only its
   public API (see countryRegistry.js).

   Persistence pattern copied 1:1 from rbac.js's makeStore() (same atomic
   tmp-file-then-rename write, same safeRead fallback-on-corruption
   behavior) so this fits the existing codebase instead of introducing a
   new convention.

   Postgres mirror: OPTIONAL and additive, following the exact approach
   already used by perf/dbPersistence.js — a generic key/JSON-blob table
   (created here as country_permission_kv so it never collides with that
   module's own app_json_store table), fire-and-forget, never blocks or
   throws into the caller. Completely inert if DATABASE_URL is not set.
   This is the "hybrid" storage requested: JSON stays the synchronous
   runtime source of truth; Postgres is a durability backstop and the
   place real relational tables (see migrations/) can grow into later.
   ========================================================================== */

const fs = require("fs");
const path = require("path");

function makeStore(dataFolder) {
    const CONFIG_FILE = path.join(dataFolder, "country_permission_config.json");

    function safeWrite(file, data) {
        const tmpFile = file + ".tmp";
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
            fs.renameSync(tmpFile, file);
        } catch (err) {
            console.error(`❌ [country-permission] Failed to write ${file}:`, err.message);
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }
    function safeRead(file, fallback) {
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (err) {
            console.error(`❌ [country-permission] Failed to read ${file}, using fallback:`, err.message);
        }
        return fallback;
    }

    // { [countryId]: { enabled, currency, timezone, notes, updatedBy, updatedAt } }
    let config = safeRead(CONFIG_FILE, {});

    function saveConfig() {
        safeWrite(CONFIG_FILE, config);
        mirrorWrite("country_permission_config", config);
    }

    // -----------------------------------------------------------------
    // Optional Postgres mirror (same philosophy as perf/dbPersistence.js:
    // JSON file remains the one synchronous source of truth; this is a
    // best-effort background copy for durability on ephemeral disks).
    // -----------------------------------------------------------------
    const DATABASE_URL = process.env.DATABASE_URL || "";
    const MIRROR_ENABLED = !!DATABASE_URL;
    const MIRROR_TABLE = "country_permission_kv";
    let pool = null;
    let ensureTablePromise = null;

    function getPool() {
        if (!MIRROR_ENABLED) return null;
        if (pool) return pool;
        try {
            const { Pool } = require("pg");
            pool = new Pool({
                connectionString: DATABASE_URL,
                connectionTimeoutMillis: 8000,
                idleTimeoutMillis: 30000,
                max: 2,
                ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
            });
            pool.on("error", (err) => {
                console.error("🐘 [country-permission] Postgres mirror pool error (JSON remains source of truth):", err.message);
            });
        } catch (err) {
            pool = null;
        }
        return pool;
    }

    function ensureTable() {
        const p = getPool();
        if (!p) return Promise.resolve(false);
        if (ensureTablePromise) return ensureTablePromise;
        ensureTablePromise = p.query(
            `CREATE TABLE IF NOT EXISTS ${MIRROR_TABLE} (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`
        ).then(() => true).catch((err) => {
            console.error("🐘 [country-permission] Failed to ensure mirror table:", err.message);
            ensureTablePromise = null;
            return false;
        });
        return ensureTablePromise;
    }

    function mirrorWrite(key, value) {
        if (!MIRROR_ENABLED) return;
        ensureTable().then((ok) => {
            if (!ok) return;
            const p = getPool();
            if (!p) return;
            p.query(
                `INSERT INTO ${MIRROR_TABLE} (key, value, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [key, JSON.stringify(value)]
            ).catch((err) => {
                console.error("🐘 [country-permission] Mirror write failed (non-fatal):", err.message);
            });
        });
    }

    return {
        getAll: () => config,
        get: (countryId) => config[countryId] || null,
        set: (countryId, patch) => {
            config[countryId] = Object.assign({}, config[countryId] || {}, patch, { updatedAt: new Date().toISOString() });
            saveConfig();
            return config[countryId];
        },
        remove: (countryId) => {
            delete config[countryId];
            saveConfig();
        }
    };
}

module.exports = { makeStore };
