ALTER TABLE managed_bots ADD COLUMN deleted_at timestamptz;
ALTER TABLE managed_bots ADD COLUMN deleted_by text;
ALTER TABLE managed_bots ADD CONSTRAINT deleted_bot_stays_archived CHECK(deleted_at IS NULL OR state='archived');
ALTER TABLE managed_bots DROP CONSTRAINT managed_bots_name_key;
CREATE UNIQUE INDEX managed_live_bot_name ON managed_bots(name) WHERE deleted_at IS NULL;
DROP INDEX managed_wechat_identity;
CREATE UNIQUE INDEX managed_wechat_identity ON managed_bots(lower(wechat_id)) WHERE deleted_at IS NULL;
