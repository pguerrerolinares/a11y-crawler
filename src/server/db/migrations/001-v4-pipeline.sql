-- v4 pipeline migration
-- Adds: audit_spans table, template columns on pages/issues, coverage fields on audits

-- New table: structured observability spans
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

-- New columns on issues for template amplification
ALTER TABLE issues ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS affected_pages INTEGER DEFAULT 1;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS amplified_from TEXT;

-- New JSONB fields on audits for template/coverage metadata
ALTER TABLE audits ADD COLUMN IF NOT EXISTS template_clusters JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS coverage JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS regression JSONB;

-- New columns on pages for template tracking
ALTER TABLE pages ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_representative BOOLEAN DEFAULT false;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS element_count INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS capabilities JSONB;
