-- A slot allows a later multi-bot policy without using a site-wide switch.
ALTER TABLE managed_bots ADD COLUMN activation_slot integer NOT NULL DEFAULT 1 CHECK(activation_slot > 0);
DROP INDEX managed_one_active_bot;
CREATE UNIQUE INDEX managed_one_active_bot_per_owner ON managed_bots(COALESCE(owner_user_id,'00000000-0000-0000-0000-000000000000'::uuid),activation_slot) WHERE state IN ('active','pausing');
ALTER TABLE managed_bot_switch ADD COLUMN owner_user_id uuid REFERENCES admins(id);
ALTER TABLE managed_bot_switch ADD COLUMN activation_slot integer NOT NULL DEFAULT 1 CHECK(activation_slot > 0);
UPDATE managed_bot_switch s SET owner_user_id=b.owner_user_id FROM managed_bots b WHERE b.id=s.target_id;
-- Never discard a pre-existing pending cutover whose owner is missing.
ALTER TABLE managed_bot_switch ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE managed_bot_switch DROP CONSTRAINT managed_bot_switch_pkey;
ALTER TABLE managed_bot_switch DROP COLUMN singleton;
ALTER TABLE managed_bot_switch ADD PRIMARY KEY(owner_user_id,activation_slot);
CREATE UNIQUE INDEX managed_switch_target ON managed_bot_switch(target_id);
CREATE TABLE managed_bot_onboarding (
 bot_id uuid PRIMARY KEY REFERENCES managed_bots(id),
 requested_wechat_id text NOT NULL,
 started_by_user_id uuid NOT NULL REFERENCES admins(id),
 environment_prepared_at timestamptz, environment_prepared_by uuid REFERENCES admins(id),
 desktop_url text NOT NULL DEFAULT '',
 account_confirmed_at timestamptz, account_confirmed_by uuid REFERENCES admins(id),
 reader_authorized_at timestamptz, reader_authorized_by uuid REFERENCES admins(id),
 completed_at timestamptz,
 revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
