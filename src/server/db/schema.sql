CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS audits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url           TEXT NOT NULL,
  config        JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  summary       JSONB,
  discovery     JSONB,
  llm_usage        JSONB,
  wcag_score       INT,
  duration_seconds INT,
  crawl_errors     JSONB,
  template_clusters JSONB,
  coverage         JSONB,
  regression       JSONB
);

CREATE TABLE IF NOT EXISTS pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT,
  status_code     INT,
  issue_count     INT DEFAULT 0,
  issues_by_impact JSONB,
  duration_ms     INT,
  template_id     TEXT,
  is_representative BOOLEAN DEFAULT false,
  fingerprint     TEXT,
  element_count   INTEGER,
  capabilities    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  rule            TEXT NOT NULL,
  impact          TEXT NOT NULL,
  description     TEXT,
  help            TEXT,
  help_url        TEXT,
  wcag_tags       JSONB,
  selector        TEXT,
  html            TEXT,
  xpath           TEXT,
  check_source    TEXT DEFAULT 'axe',
  category        TEXT,
  suggested_fix   TEXT,
  fix_confidence  TEXT,
  template_id     TEXT,
  affected_pages  INTEGER DEFAULT 1,
  amplified_from  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          SERIAL PRIMARY KEY,
  audit_id    UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_logs (
  id            SERIAL PRIMARY KEY,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status_code   INT,
  duration_ms   INT,
  ip            TEXT,
  user_agent    TEXT,
  request_body  JSONB,
  response_size INT,
  error         TEXT,
  response_body TEXT,
  content_type  TEXT,
  query_params  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);
CREATE INDEX IF NOT EXISTS idx_audits_created ON audits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_audit ON pages(audit_id);
CREATE INDEX IF NOT EXISTS idx_issues_audit ON issues(audit_id);
CREATE INDEX IF NOT EXISTS idx_issues_impact ON issues(audit_id, impact);
CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(audit_id, rule);
CREATE INDEX IF NOT EXISTS idx_events_audit ON audit_events(audit_id);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_path ON request_logs(path);

CREATE TABLE IF NOT EXISTS audit_spans (
  id             BIGSERIAL PRIMARY KEY,
  audit_id       UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  trace_id       UUID NOT NULL,
  span_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_span_id UUID,
  name           TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_ms    INTEGER GENERATED ALWAYS AS (
                   EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                 ) STORED,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
  error_message  TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spans_audit ON audit_spans(audit_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON audit_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_name ON audit_spans(name);
CREATE INDEX IF NOT EXISTS idx_spans_metadata ON audit_spans USING GIN(metadata);

-- Migration 2026-03-09: backend backlog
-- Run once on existing databases:
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS wcag_score INT;
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS duration_seconds INT;
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_errors JSONB;
