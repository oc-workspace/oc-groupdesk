CREATE TABLE managed_bots (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE, wechat_id text NOT NULL,
 host_label text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('active','pausing','paused','archived')) DEFAULT 'paused',
 database_state text NOT NULL CHECK(database_state IN ('legacy','ready','provisioning','failed')),
 db_name text UNIQUE, db_role text UNIQUE, db_password_ciphertext text,
 model_key_ciphertext text, data_namespace text UNIQUE,
 revision integer NOT NULL DEFAULT 1, activation_generation integer NOT NULL DEFAULT 0,
 runtime_instance_id uuid, account_fingerprint text, runtime_status jsonb NOT NULL DEFAULT '{}',
 runtime_seen_at timestamptz, stopped_revision integer, pause_requested_at timestamptz,
 error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX managed_wechat_identity ON managed_bots(lower(wechat_id));
CREATE UNIQUE INDEX managed_one_active_bot ON managed_bots((true)) WHERE state IN ('active','pausing');
CREATE TABLE managed_bot_adapters (
 token_hash text PRIMARY KEY, bot_id uuid NOT NULL REFERENCES managed_bots(id),
 name text NOT NULL, group_external_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_bot_switch (
 singleton boolean PRIMARY KEY CHECK(singleton) DEFAULT true,
 target_id uuid NOT NULL REFERENCES managed_bots(id), requested_at timestamptz NOT NULL DEFAULT now()
);
