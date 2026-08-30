CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS operations (
  organization_id text NOT NULL,
  id text NOT NULL,
  version text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS operations_container_idx
  ON operations (organization_id, ((snapshot ->> 'containerId')));

CREATE TABLE IF NOT EXISTS shipment_events (
  organization_id text NOT NULL,
  id text NOT NULL,
  operation_id text NOT NULL,
  type text NOT NULL,
  label text NOT NULL,
  location text,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS shipment_events_latest_idx
  ON shipment_events (organization_id, operation_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS call_sessions (
  organization_id text NOT NULL,
  id text NOT NULL,
  operation_id text NOT NULL,
  carrier_id text,
  driver_name text,
  direction text NOT NULL,
  status text NOT NULL,
  audio_url text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  organization_id text NOT NULL,
  id text NOT NULL,
  operation_id text NOT NULL,
  call_id text NOT NULL,
  speaker text NOT NULL,
  text text NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  created_at timestamptz NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('spanish', coalesce(text, ''))) STORED,
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS transcript_segments_search_idx
  ON transcript_segments USING gin (search_vector);
CREATE INDEX IF NOT EXISTS transcript_segments_trigram_idx
  ON transcript_segments USING gin (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS transcript_segments_call_idx
  ON transcript_segments (organization_id, operation_id, call_id, start_ms);

CREATE TABLE IF NOT EXISTS agent_conversations (
  organization_id text NOT NULL,
  id text NOT NULL,
  created_by text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  organization_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx
  ON agent_messages (organization_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_actions (
  organization_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  operation_id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL,
  expected_operation_version text NOT NULL,
  requested_by text NOT NULL,
  decided_by text,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  executed_at timestamptz,
  failure_reason text,
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX IF NOT EXISTS agent_actions_pending_idx
  ON agent_actions (organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS retention_policies (
  organization_id text PRIMARY KEY,
  audio_days integer NOT NULL DEFAULT 90,
  transcript_days integer NOT NULL DEFAULT 365,
  audit_days integer NOT NULL DEFAULT 1825,
  legal_hold boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
