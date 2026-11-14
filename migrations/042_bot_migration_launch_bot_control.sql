CREATE TABLE IF NOT EXISTS managed_bot_migration_launches (
 id uuid PRIMARY KEY,
 change_id uuid NOT NULL UNIQUE REFERENCES managed_bot_deployment_changes(id),
 bot_id uuid NOT NULL REFERENCES managed_bots(id),
 greeting_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
 catchup_from timestamptz NOT NULL,
 catchup_through timestamptz NOT NULL,
 activation_generation integer,
 state text NOT NULL CHECK (state IN ('requested','running','completed','attention')) DEFAULT 'requested',
 greeting_done jsonb NOT NULL DEFAULT '[]'::jsonb,
 catchup_scanned integer NOT NULL DEFAULT 0,
 catchup_sent integer NOT NULL DEFAULT 0,
 catchup_attention integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS managed_bot_migration_launches_bot ON managed_bot_migration_launches(bot_id,created_at DESC);
