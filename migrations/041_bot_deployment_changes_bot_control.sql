ALTER TABLE managed_runtime_hosts DROP CONSTRAINT managed_runtime_hosts_id_check;
ALTER TABLE managed_runtime_hosts ADD CONSTRAINT managed_runtime_hosts_id_check
 CHECK (id IN ('rococo-root','rococo-root2','rpi-groupdesk-01'));
INSERT INTO managed_runtime_hosts(id,name,enabled,can_cleanup)
 VALUES('rpi-groupdesk-01','树莓派机器人运行环境',false,true)
 ON CONFLICT(id) DO NOTHING;

ALTER TABLE managed_bots ADD COLUMN runtime_host_id text REFERENCES managed_runtime_hosts(id);
UPDATE managed_bots SET runtime_host_id='rococo-root2'
 WHERE host_label='rococo-root2' AND runtime_host_id IS NULL;

CREATE TABLE managed_bot_deployment_changes (
 id uuid PRIMARY KEY,
 bot_id uuid NOT NULL REFERENCES managed_bots(id),
 source_host_id text REFERENCES managed_runtime_hosts(id),
 target_host_id text NOT NULL REFERENCES managed_runtime_hosts(id),
 kind text NOT NULL CHECK(kind IN ('host_move','same_host_upgrade','connection_config')),
 state text NOT NULL CHECK(state IN ('requested','approved','verifying','completed','cancelled','failed')),
 reason text NOT NULL,
 expected_bot_revision integer NOT NULL,
 requested_by uuid NOT NULL REFERENCES admins(id),
 approved_by uuid REFERENCES admins(id),
 completed_by uuid REFERENCES admins(id),
 verification jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX managed_bot_one_open_deployment_change
 ON managed_bot_deployment_changes(bot_id)
 WHERE state IN ('requested','approved','verifying');
CREATE INDEX managed_bot_deployment_changes_recent
 ON managed_bot_deployment_changes(bot_id,created_at DESC);
