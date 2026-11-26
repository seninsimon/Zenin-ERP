-- The Spreadsheet view is on for every table (it has Undo now); an admin can
-- still switch it off per table (Tables & columns → the table → Access).
ALTER TABLE table_schemas ALTER COLUMN spreadsheet SET DEFAULT true;
UPDATE table_schemas SET spreadsheet = true;
