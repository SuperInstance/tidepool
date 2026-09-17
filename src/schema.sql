-- tidepool v1 bench schema — DDL for a hermit PR #3 migration.
-- quilt_wal is PR #1/#2's table (drizzle/0013_quilt_kernel_wal.sql); shown
-- here so the bench is self-contained.

CREATE TABLE IF NOT EXISTS quilt_wal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  mutation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  cell TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quilt_wal_mutation_idx ON quilt_wal (mutation_id);

-- Recalled design v1: helperThreads — one row per remembered helper thread.
CREATE TABLE IF NOT EXISTS helper_threads (
  id TEXT PRIMARY KEY NOT NULL,            -- discord thread id
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  helper_key TEXT NOT NULL,
  helper_name TEXT NOT NULL,
  question_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  response_length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  author_username TEXT NOT NULL,
  last_message_id TEXT
);
CREATE INDEX IF NOT EXISTS helper_threads_channel_idx ON helper_threads (channel_id);
CREATE INDEX IF NOT EXISTS helper_threads_guild_idx ON helper_threads (guild_id);

-- Recalled design v1: helperLogs — raw message log per thread (json string).
CREATE TABLE IF NOT EXISTS helper_logs (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  messages TEXT NOT NULL,                  -- JSON string, append-only
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id)
);
