ALTER TABLE groups ADD COLUMN deleted_at timestamptz;
ALTER TABLE groups ADD COLUMN deleted_by text;
ALTER TABLE groups ADD CONSTRAINT deleted_group_stays_disabled CHECK(deleted_at IS NULL OR NOT enabled);
ALTER TABLE groups DROP CONSTRAINT groups_external_id_key;
CREATE UNIQUE INDEX live_group_external_id ON groups(external_id) WHERE deleted_at IS NULL;
