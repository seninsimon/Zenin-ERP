-- Bring your data, part 4 (workspace/DATA_RULES_PLAN.md): the calculations
-- Zenin found in the imported data (src/migration/rules.ts). NULL until it
-- has looked; each rule says whether it's in use, with what "Change back"
-- needs (the column as it was, and the values the formula changed).
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS rules JSONB;
