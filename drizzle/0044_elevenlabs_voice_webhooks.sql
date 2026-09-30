-- Materialize the post-call reconciliation source before the first webhook arrives.
-- The webhook owner in lib/elevenlabs-post-call.ts retains the same additive schema.
CREATE TABLE IF NOT EXISTS elevenlabs_voice_webhooks (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS elevenlabs_voice_webhooks_conversation_idx ON elevenlabs_voice_webhooks(conversation_id,created_at);
