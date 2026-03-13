-- Migration: clean slate for v4 pipeline deployment
-- Run ONCE before deploying the v4 code to production.
--
-- This removes all old audit data and the legacy shared_issues table.
-- The schema itself (tables, indexes) is preserved and recreated by schema.sql.
--
-- Usage: psql $DATABASE_URL -f scripts/migrate-clean-v4.sql

BEGIN;

-- Remove all audit data (cascades to pages, issues, events, spans)
TRUNCATE audits CASCADE;

-- Drop legacy table no longer used by v4 pipeline
DROP TABLE IF EXISTS shared_issues;

COMMIT;
