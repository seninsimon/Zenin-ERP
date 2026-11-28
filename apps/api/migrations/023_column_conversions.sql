-- A typed field made into a formula or total (Make it a formula, or "Use it"
-- on a rule found in imported data: schema/convert.ts). Kept while it lasts,
-- for Change back: the field as it was, and the values the formula replaced
-- (record id -> old value; null when it was empty).
CREATE TABLE IF NOT EXISTS column_conversions (
  table_name   TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  original     JSONB NOT NULL,
  restore      JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed      INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, column_name)
);
