CREATE TABLE IF NOT EXISTS carriers (
  organization_id text NOT NULL, id text NOT NULL,
  name text NOT NULL, phone text NOT NULL,
  lanes text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id));
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS quote_id text;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE operations  ADD COLUMN IF NOT EXISTS pipeline_stage text;
CREATE INDEX IF NOT EXISTS operations_stage_idx ON operations (organization_id, pipeline_stage);
ALTER TABLE carriers ENABLE ROW LEVEL SECURITY;
