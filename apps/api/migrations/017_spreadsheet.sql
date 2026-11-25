-- The Spreadsheet view, per table (workspace/SPREADSHEET_PLAN.md): an admin
-- switches it on in Tables → the table → Access. Off for every table until then.
ALTER TABLE table_schemas ADD COLUMN IF NOT EXISTS spreadsheet BOOLEAN NOT NULL DEFAULT false;
