-- ==========================================================================
-- Country Permission — Extension Schema (Migration 001)
-- ==========================================================================
-- ADDITIVE ONLY. This file never ALTERs, DROPs, or renames anything in the
-- existing schema (including the app_json_store table used by
-- perf/dbPersistence.js). Everything here is a brand-new table.
--
-- Run manually against DATABASE_URL when/if the project moves this module
-- from JSON+mirror storage to Postgres as the primary store, e.g.:
--   psql "$DATABASE_URL" -f 001_country_permission_extension.sql
-- Safe to run multiple times (IF NOT EXISTS everywhere).
-- ==========================================================================

-- Per-country extension config (enabled flag, currency, timezone, notes).
-- The list of *which countries exist* stays owned by rbac.js's in-code
-- COUNTRIES list — this table only stores the extra config layered on top,
-- keyed by that same country id (e.g. 'IN', 'BD', 'PK', 'AR', 'OTHERS').
CREATE TABLE IF NOT EXISTS country_config (
    country_id      TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    currency        TEXT,
    timezone        TEXT,
    notes           TEXT,
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic resource -> country mapping. Rather than adding a country_id
-- column to every new table the Merchant / Call Hosting modules (later
-- stages of this package) will create, they can insert one row here per
-- resource and reuse the same scope-check helpers (see filtering.js /
-- middleware.js). resource_type is a short tag, e.g. 'merchant',
-- 'call_host', 'seller'.
CREATE TABLE IF NOT EXISTS country_resource_scope (
    id              BIGSERIAL PRIMARY KEY,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    country_id      TEXT NOT NULL REFERENCES country_config(country_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_country_resource_scope_country
    ON country_resource_scope (country_id);
CREATE INDEX IF NOT EXISTS idx_country_resource_scope_type
    ON country_resource_scope (resource_type);

-- Optional dedicated audit trail for country-scope decisions/config
-- changes. The module works today purely through rbac.logAction() (the
-- existing JSON audit log) — this table is only needed if/when the
-- project migrates that audit log to Postgres too. Not written to by any
-- code in this package yet.
CREATE TABLE IF NOT EXISTS country_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        TEXT,
    admin_username  TEXT,
    action          TEXT NOT NULL,
    country_id      TEXT,
    meta            JSONB,
    ip              TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_country_audit_log_country ON country_audit_log (country_id);
CREATE INDEX IF NOT EXISTS idx_country_audit_log_created ON country_audit_log (created_at);

-- Generic key/JSONB mirror table used by country_permission/store.js's
-- optional Postgres backstop (same pattern as perf/dbPersistence.js's
-- app_json_store, kept as a separate table so the two never collide).
CREATE TABLE IF NOT EXISTS country_permission_kv (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
