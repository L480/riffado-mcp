-- Minimal Riffado schema for integration tests — mirrors the shape verified
-- on node1 (see riffado-mcp spec §3 / CLAUDE.md), not the full production
-- migration history.
CREATE TABLE IF NOT EXISTS recordings (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  filename text,
  duration integer,
  start_time timestamp NOT NULL,
  end_time timestamp,
  filesize bigint,
  storage_type text,
  storage_path text,
  is_trash boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp
);

CREATE TABLE IF NOT EXISTS transcriptions (
  id text PRIMARY KEY,
  recording_id text NOT NULL REFERENCES recordings (id),
  user_id text NOT NULL,
  text text,
  provider varchar,
  model varchar,
  detected_language varchar(10),
  transcription_type text,
  source varchar NOT NULL,
  UNIQUE (recording_id, user_id, source)
);

CREATE TABLE IF NOT EXISTS ai_enhancements (
  id text PRIMARY KEY,
  recording_id text NOT NULL REFERENCES recordings (id),
  user_id text NOT NULL,
  summary text,
  action_items jsonb,
  key_points jsonb,
  provider text,
  model text,
  created_at timestamp NOT NULL DEFAULT now(),
  source text
);
