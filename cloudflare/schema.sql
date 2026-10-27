-- Nadda Daily archive and visitor log.
-- Safe to re-run. Wrangler records this file in d1_migrations.

CREATE TABLE IF NOT EXISTS issues (
  date TEXT PRIMARY KEY,
  issue_no INTEGER,
  headline TEXT NOT NULL DEFAULT '',
  tagline TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_sha TEXT,
  ingested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  issue_date TEXT,
  viewed_at TEXT NOT NULL,
  day TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  visitor_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_views(day);
CREATE INDEX IF NOT EXISTS idx_page_views_issue ON page_views(issue_date);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_hash);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
