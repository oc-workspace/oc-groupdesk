CREATE TABLE managed_bot_purges(
 id uuid PRIMARY KEY,bot_id uuid NOT NULL UNIQUE REFERENCES managed_bots(id),actor_user_id uuid NOT NULL REFERENCES admins(id),
 status text NOT NULL CHECK(status IN ('queued','processing','completed','partial','failed','cancelled')),
 reason text NOT NULL,reason_note text NOT NULL DEFAULT '',expected_revision integer NOT NULL,expected_owner uuid NOT NULL,
 plan jsonb NOT NULL,phase text NOT NULL DEFAULT 'planned',runtime_quarantine_id uuid REFERENCES managed_runtime_jobs(id),runtime_purge_id uuid REFERENCES managed_runtime_jobs(id),
 receipt jsonb NOT NULL DEFAULT '{}',error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
