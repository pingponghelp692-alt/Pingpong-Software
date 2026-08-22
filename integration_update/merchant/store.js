/* ==========================================================================
   Merchant — Store
   ==========================================================================
   Flat-JSON source of truth for merchant records, own data file
   (merchants.json), separate from every existing data file — nothing here
   reads or writes rbac.js's admin_accounts.json or any other existing
   store. Persistence pattern copied 1:1 from
   integration_update/country_permission/store.js (same atomic
   tmp-file-then-rename write, same safeRead fallback-on-corruption
   behavior, same optional best-effort Postgres mirror), so this fits the
   existing codebase instead of introducing a new convention.

   Postgres mirror table is merchant_kv — distinct from
   country_permission_kv and perf/dbPersistence.js's app_json_store, so
   none of the three ever collide. Completely inert if DATABASE_URL is
   not set.
   ========================================================================== */

const fs = require("fs");
const path = require("path");

function makeStore(dataFolder) {
    const DATA_FILE = path.join(dataFolder, "merchants.json");

    function safeWrite(file, data) {
        const tmpFile = file + ".tmp";
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
            fs.renameSync(tmpFile, file);
        } catch (err) {
            console.error(`❌ [merchant] Failed to write ${file}:`, err.message);
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }
    function safeRead(file, fallback) {
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (err) {
            console.error(`❌ [merchant] Failed to read ${file}, using fallback:`, err.message);
        }
        return fallback;
    }

    // { [merchantId]: { id, name, countryId, contact, status, notes, createdBy, createdAt, updatedBy, updatedAt } }
    let merchants = safeRead(DATA_FILE, {});

    function save() {
        safeWrite(DATA_FILE, merchants);
        mirrorWrite("merchants", merchants);
    }

    // -----------------------------------------------------------------
    // Optional Postgres mirror (same philosophy as country_permission's
    // store.js / perf/dbPersistence.js: JSON file remains the one
    // synchronous source of truth; this is a best-effort background copy
    // for durability on ephemeral disks).
    // -----------------------------------------------------------------
    const DATABASE_URL = process.env.DATABASE_URL || "";
    const MIRROR_ENABLED = !!DATABASE_URL;
    const MIRROR_TABLE = "merchant_kv";
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
                console.error("🐘 [merchant] Postgres mirror pool error (JSON remains source of truth):", err.message);
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
            console.error("🐘 [merchant] Failed to ensure mirror table:", err.message);
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
                console.error("🐘 [merchant] Mirror write failed (non-fatal):", err.message);
            });
        });
    }

    return {
        getAll: () => merchants,
        get: (id) => merchants[id] || null,
        set: (id, record) => {
            merchants[id] = record;
            save();
            return merchants[id];
        },
        remove: (id) => {
            delete merchants[id];
            save();
        }
    };
}

module.exports = { makeStore };
