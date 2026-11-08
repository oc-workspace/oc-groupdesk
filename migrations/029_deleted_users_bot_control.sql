ALTER TABLE admins ADD COLUMN deleted_at timestamptz;
ALTER TABLE admins ADD COLUMN deleted_by text;
ALTER TABLE admins ADD CONSTRAINT deleted_user_stays_disabled CHECK(deleted_at IS NULL OR status='disabled');
ALTER TABLE admins DROP CONSTRAINT admins_github_id_key;
CREATE UNIQUE INDEX live_user_github_identity ON admins(github_id) WHERE deleted_at IS NULL;
