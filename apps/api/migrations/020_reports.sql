-- Reports (workspace/REPORTS_PLAN.md, part 3): a saved summary of a table
-- (group by, count/total/average, chart, filters), shown in its app's block
-- on Home and on the app's page. Gone with its table.
CREATE TABLE IF NOT EXISTS reports (
  _id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  table_name  TEXT NOT NULL REFERENCES table_schemas(table_name) ON DELETE CASCADE ON UPDATE CASCADE,
  group_by    TEXT NOT NULL,
  show        TEXT NOT NULL DEFAULT 'count',
  chart       TEXT,
  filters     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- a ready-made one: the app that added it (removed with the app)
  app_key     TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_table_idx ON reports (table_name);
