-- module4/wallet/schema.sql
-- ==================================================
-- MODULE 4 — STEP 4.4: WALLET LEDGER SCHEMA
-- ==================================================
-- Table names are prefixed module4_ specifically so this can never
-- collide with any existing table in the project's Postgres database
-- (the existing perf/dbPersistence.js uses a single generic
-- app_json_store table — different name, different shape, no overlap).
--
-- Applied via db.js's ensureSchema() using CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS — safe to run every boot, never destructive.

-- The durable, append-mostly transaction record. Source of truth for
-- "did this exact operation already happen" (txn_id UNIQUE) and for
-- reconstructing/auditing/repairing balances from scratch if ever
-- needed (reconcileBalance() sums this table).
CREATE TABLE IF NOT EXISTS module4_wallet_ledger (
    txn_id        TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    currency      TEXT NOT NULL,
    amount        BIGINT NOT NULL,          -- signed delta: positive=credit, negative=debit
    balance_after BIGINT,                    -- filled in once status is no longer 'pending'
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | completed | rejected
    reason        TEXT,
    context       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS module4_wallet_ledger_user_idx
    ON module4_wallet_ledger (user_id, currency, created_at);

-- The fast-read running total. Always derivable from module4_wallet_ledger
-- (status='completed' rows) if this table is ever lost or needs repair —
-- see index.js's reconcileBalance(). This table is a materialized cache
-- of the ledger for read speed, not an independent source of truth.
CREATE TABLE IF NOT EXISTS module4_wallet_balances (
    user_id    TEXT NOT NULL,
    currency   TEXT NOT NULL,
    balance    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, currency)
);
