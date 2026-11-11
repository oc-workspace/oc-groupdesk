ALTER TABLE summary_parts ADD COLUMN source_epoch text;
ALTER TABLE summary_parts ADD COLUMN source_seq bigint;
ALTER TABLE summary_parts ADD COLUMN wechat_server_id text;
ALTER TABLE summary_parts ADD COLUMN source_confirmed_at timestamptz;
ALTER TABLE summary_parts ADD CONSTRAINT summary_parts_source_reference_complete CHECK (
  (source_epoch IS NULL AND source_seq IS NULL AND wechat_server_id IS NULL AND source_confirmed_at IS NULL)
  OR (source_epoch ~ '^[a-f0-9]{32}$' AND source_seq > 0 AND wechat_server_id ~ '^[1-9][0-9]{0,20}$' AND source_confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX summary_parts_reader_message ON summary_parts(source_epoch,source_seq) WHERE source_epoch IS NOT NULL;

ALTER TABLE summary_jobs ADD COLUMN trigger_kind text NOT NULL DEFAULT 'admin';
ALTER TABLE summary_jobs ADD COLUMN trigger_mode text;
ALTER TABLE summary_jobs ADD COLUMN trigger_actor_id text;
ALTER TABLE summary_jobs ADD COLUMN trigger_actor_name text;
ALTER TABLE summary_jobs ADD COLUMN trigger_source_epoch text;
ALTER TABLE summary_jobs ADD COLUMN trigger_source_seq bigint;
ALTER TABLE summary_jobs ADD COLUMN trigger_source_server_id text;
UPDATE summary_jobs SET trigger_kind='schedule' WHERE schedule_id IS NOT NULL;
ALTER TABLE summary_jobs ADD CONSTRAINT summary_jobs_trigger_kind CHECK (trigger_kind IN ('admin','schedule','group_command'));
ALTER TABLE summary_jobs ADD CONSTRAINT summary_jobs_trigger_mode CHECK (trigger_mode IS NULL OR trigger_mode IN ('previous_day','today'));
ALTER TABLE summary_jobs ADD CONSTRAINT summary_jobs_command_metadata CHECK (
  trigger_kind <> 'group_command' OR (
    trigger_mode IS NOT NULL AND trigger_actor_id IS NOT NULL AND
    trigger_source_epoch ~ '^[a-f0-9]{32}$' AND trigger_source_seq > 0 AND
    trigger_source_server_id ~ '^[1-9][0-9]{0,20}$'
  )
);
CREATE UNIQUE INDEX summary_jobs_command_source ON summary_jobs(group_id,trigger_source_epoch,trigger_source_seq) WHERE trigger_kind='group_command';
