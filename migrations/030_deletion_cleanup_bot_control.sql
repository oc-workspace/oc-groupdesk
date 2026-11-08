ALTER TABLE admins ADD COLUMN deletion_reason text;
ALTER TABLE admins ADD COLUMN deletion_note text NOT NULL DEFAULT '';
ALTER TABLE managed_bots ADD COLUMN deletion_reason text;
ALTER TABLE managed_bots ADD COLUMN deletion_note text NOT NULL DEFAULT '';
ALTER TABLE managed_bots ADD COLUMN storage_purged_at timestamptz;
ALTER TABLE managed_bots ADD CONSTRAINT purged_bot_is_deleted CHECK(storage_purged_at IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE managed_model_keys ADD COLUMN secret_purged_at timestamptz;
ALTER TABLE managed_model_keys ADD CONSTRAINT purged_key_stays_archived CHECK(secret_purged_at IS NULL OR (archived AND NOT enabled AND secret_ciphertext='erased:v1'));
CREATE TABLE managed_deletion_cleanups(
 id uuid PRIMARY KEY,user_id uuid NOT NULL UNIQUE REFERENCES admins(id),actor_user_id uuid NOT NULL REFERENCES admins(id),
 status text NOT NULL CHECK(status IN ('queued','processing','completed','partial','failed')),
 reason text NOT NULL,reason_note text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,
 error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE TABLE managed_deletion_cleanup_items(
 cleanup_id uuid NOT NULL REFERENCES managed_deletion_cleanups(id),kind text NOT NULL CHECK(kind IN ('bot','key')),target_id uuid NOT NULL,
 name text NOT NULL,state text NOT NULL CHECK(state IN ('pending','skipped','done','failed')),phase text NOT NULL DEFAULT 'planned',
 message text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(cleanup_id,kind,target_id)
);
