-- New control-plane records only. Existing tasks and deployed robots are unchanged.
CREATE TABLE managed_bot_installation_preferences (
 bot_id uuid PRIMARY KEY REFERENCES managed_bots(id) ON DELETE CASCADE,
 reading_mode text NOT NULL CHECK(reading_mode IN ('auto','database','gui')),
 updated_by_user_id uuid REFERENCES admins(id),updated_at timestamptz NOT NULL DEFAULT now(),
 reported_method text NOT NULL DEFAULT 'unknown' CHECK(reported_method IN ('unknown','chatlog_keeper','chatlog','gui','macos_wechat_export')),
 reported_source text,reported_at timestamptz
);
CREATE TABLE managed_bot_installation_events (
 bot_id uuid NOT NULL REFERENCES managed_bots(id) ON DELETE CASCADE,report_id uuid NOT NULL,
 event_seq bigint GENERATED ALWAYS AS IDENTITY,received_at timestamptz NOT NULL DEFAULT now(),source text NOT NULL CHECK(source IN ('owner_upload','paired_device','site')),
 details jsonb NOT NULL,PRIMARY KEY(bot_id,report_id)
);
CREATE INDEX managed_bot_installation_event_recent ON managed_bot_installation_events(bot_id,event_seq DESC);
