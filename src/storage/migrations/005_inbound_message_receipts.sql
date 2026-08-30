CREATE TABLE IF NOT EXISTS inbound_message_receipts (
  channel text NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (channel, message_id)
);

CREATE INDEX IF NOT EXISTS inbound_message_receipts_status_idx
  ON inbound_message_receipts (status, claimed_at);

ALTER TABLE inbound_message_receipts ENABLE ROW LEVEL SECURITY;
