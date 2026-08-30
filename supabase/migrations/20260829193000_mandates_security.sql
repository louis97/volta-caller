CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_cap numeric NOT NULL CHECK (budget_cap > 0),
  destination_datetime timestamptz NOT NULL,
  destination_place text NOT NULL CHECK (length(btrim(destination_place)) > 0),
  type_of_content text NOT NULL CHECK (length(btrim(type_of_content)) > 0),
  weight numeric NOT NULL CHECK (weight > 0),
  measures text NOT NULL CHECK (length(btrim(measures)) > 0),
  pickup_address text NOT NULL CHECK (length(btrim(pickup_address)) > 0),
  pickup_datetime timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_datetime < destination_datetime)
);

CREATE INDEX IF NOT EXISTS mandates_created_at_idx
  ON mandates (created_at DESC);

ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mandates ENABLE ROW LEVEL SECURITY;
