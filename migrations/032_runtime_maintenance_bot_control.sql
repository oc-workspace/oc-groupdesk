CREATE TABLE managed_runtime_hosts(
 id text PRIMARY KEY CHECK(id IN ('rococo-root','rococo-root2')),name text NOT NULL,
 token_hash text,permit_ciphertext text,enabled boolean NOT NULL DEFAULT false,can_cleanup boolean NOT NULL DEFAULT false,
 last_seen_at timestamptz,version text
);
CREATE UNIQUE INDEX runtime_unique_host_token ON managed_runtime_hosts(token_hash) WHERE token_hash IS NOT NULL;
INSERT INTO managed_runtime_hosts(id,name,can_cleanup) VALUES('rococo-root','GroupDesk与站点备份',false),('rococo-root2','微信机器人运行环境',true);
CREATE TABLE managed_runtime_snapshots(
 id uuid PRIMARY KEY,host_id text NOT NULL REFERENCES managed_runtime_hosts(id),report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON managed_runtime_snapshots(host_id,created_at DESC);
CREATE TABLE managed_runtime_jobs(
 id uuid PRIMARY KEY,host_id text NOT NULL REFERENCES managed_runtime_hosts(id),bot_id uuid REFERENCES managed_bots(id),
 action text NOT NULL CHECK(action IN ('scan','quarantine','purge','restore')),
 status text NOT NULL CHECK(status IN ('queued','preparing','executing','completed','failed','cancelled')),
 actor_user_id uuid NOT NULL REFERENCES admins(id),reason text NOT NULL,reason_note text NOT NULL DEFAULT '',
 expected_revision integer,expected_owner uuid,plan_hash text,selection text[] NOT NULL DEFAULT '{}',retention_days integer,
 parent_job_id uuid REFERENCES managed_runtime_jobs(id),lease_token uuid,lease_until timestamptz,
 receipt jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE UNIQUE INDEX runtime_one_mutation ON managed_runtime_jobs(bot_id) WHERE action<>'scan' AND status IN ('queued','preparing','executing');
CREATE UNIQUE INDEX runtime_one_scan ON managed_runtime_jobs(host_id) WHERE action='scan' AND status IN ('queued','preparing','executing');
