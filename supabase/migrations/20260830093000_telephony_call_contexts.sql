CREATE TABLE IF NOT EXISTS telephony_call_contexts (
  token_hash text PRIMARY KEY,
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  carrier_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS telephony_call_contexts_expiry_idx
  ON telephony_call_contexts (expires_at);

ALTER TABLE telephony_call_contexts ENABLE ROW LEVEL SECURITY;
