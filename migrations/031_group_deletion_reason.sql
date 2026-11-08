ALTER TABLE groups ADD COLUMN deletion_reason text;
ALTER TABLE groups ADD COLUMN deletion_note text NOT NULL DEFAULT '';
