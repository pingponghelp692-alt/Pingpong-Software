-- ==========================================================================
-- Merchant — Extension Schema (Migration 001)
-- ==========================================================================
-- ADDITIVE ONLY. This file never ALTERs, DROPs, or renames anything in the
-- existing schema (including country_config / country_resource_scope /
-- country_permission_kv from country_permission's own migration, or
-- app_json_store from perf/dbPersistence.js). Everything here is a
-- brand-new table.
--
-- Run manually against DATABASE_URL when/if the project moves this module
-- from JSON+mirror storage to Postgres as the primary store, e.g.:
--   psql "$DATABASE_URL" -f 001_merchant_extension.sql
-- Safe to run multiple times (IF NOT EXISTS everywhere).
-- Requires 001_country_permission_extension.sql to have run first (FK
-- reference below to country_config).
-- ==========================================================================

CREATE TABLE IF NOT EXISTS merchants (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    country_id      TEXT NOT NULL REFERENCES country_config(country_id),
    contact         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    notes           TEXT,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_merchants_country ON merchants (country_id);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants (status);

-- Generic key/JSONB mirror table used by merchant/store.js's optional
-- Postgres backstop (same pattern as country_permission_kv / app_json_store,
-- kept as its own table so none of the three ever collide).
CREATE TABLE IF NOT EXISTS merchant_kv (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
