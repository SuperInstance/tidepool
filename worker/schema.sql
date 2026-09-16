CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'lesson',
  author TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  native TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_artifacts_author ON artifacts(author);
CREATE INDEX IF NOT EXISTS idx_artifacts_repo ON artifacts(repo);
CREATE INDEX IF NOT EXISTS idx_artifacts_ts ON artifacts(ts);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  repo TEXT,
  task TEXT,
  outcome TEXT,
  lesson_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
