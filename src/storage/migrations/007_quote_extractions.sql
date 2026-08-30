CREATE TABLE IF NOT EXISTS quote_extractions (
  organization_id text NOT NULL,
  id text NOT NULL,
  operation_id text NOT NULL,
  call_id text NOT NULL,
  quote_id text,
  final_price_mxn numeric,
  currency text,
  agreed_at timestamptz,
  summary text,
  status text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS quote_extractions_call_idx
  ON quote_extractions (organization_id, call_id);

ALTER TABLE quote_extractions ENABLE ROW LEVEL SECURITY;
