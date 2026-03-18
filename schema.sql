-- Run this in your Neon SQL editor to set up the database
-- https://console.neon.tech -> your project -> SQL Editor

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  repo        TEXT DEFAULT '',
  framework   TEXT DEFAULT '',
  region      TEXT DEFAULT '',
  domain      TEXT DEFAULT '',
  visitors    INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'queued',
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  build_time  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_logs (
  id      SERIAL PRIMARY KEY,
  run_id  INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  level   TEXT DEFAULT 'info',
  message TEXT,
  ts      TIMESTAMPTZ DEFAULT NOW()
);
