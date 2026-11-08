-- Additive only: old tasks keep their IDs, timestamps, confirmations and revisions.
ALTER TABLE managed_bot_onboarding ADD COLUMN deployment_mode text CHECK(deployment_mode IN ('hosted','self_hosted'));
ALTER TABLE managed_bot_onboarding ADD COLUMN device_kind text NOT NULL DEFAULT 'computer' CHECK(device_kind IN ('computer','server'));
ALTER TABLE managed_bot_onboarding ADD COLUMN device_os text NOT NULL DEFAULT 'unknown' CHECK(device_os IN ('unknown','linux','windows','macos'));
ALTER TABLE managed_bot_onboarding ADD COLUMN installation_model jsonb;
ALTER TABLE managed_bot_onboarding ADD COLUMN installation_plan text NOT NULL DEFAULT '';
ALTER TABLE managed_bot_onboarding ADD COLUMN installation_plan_at timestamptz;
CREATE TABLE managed_bot_device_pairings (
 code_hash text PRIMARY KEY,
 bot_id uuid NOT NULL REFERENCES managed_bots(id),
 owner_user_id uuid NOT NULL REFERENCES admins(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, instance_id uuid,
 CHECK(expires_at > created_at)
);
CREATE INDEX managed_bot_device_pairing_bot ON managed_bot_device_pairings(bot_id);
