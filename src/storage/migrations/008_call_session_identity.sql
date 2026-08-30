-- A call session is identified two ways: by the id the round generated when it
-- dialled, and by the Twilio sid that every callback and media stream speaks.
-- Persisting only the first meant the sid could not be looked up, so a media
-- stream that arrived without a resolvable call context had no way to find the
-- shipment its call belonged to and was filed under whatever operation the
-- instance happened to be holding.
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS call_sid text;

-- Who the caller is hearing. Without it a takeover survived only in memory, so
-- the console showed the agent in charge of a call a person had already joined.
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS supervision jsonb;

CREATE INDEX IF NOT EXISTS call_sessions_call_sid_idx
  ON call_sessions (organization_id, call_sid);
