-- Bring your data (data migration, part 1): one row per uploaded set of
-- files. "review" while the admin checks the plan; "importing" in the
-- background; then "done" (with the proof in `result`) or "failed".
CREATE TABLE IF NOT EXISTS migrations (
  _id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'review',
  plan            JSONB NOT NULL,
  file_keys       TEXT[] NOT NULL DEFAULT '{}',
  file_names      TEXT[] NOT NULL DEFAULT '{}',
  app_key         TEXT,
  created_tables  TEXT[] NOT NULL DEFAULT '{}',
  result          JSONB,
  error           TEXT,
  problems_key    TEXT,
  job_id          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
