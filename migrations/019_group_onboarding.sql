-- Additive, per-business-workspace onboarding queue; existing groups unchanged.
CREATE TABLE group_onboarding_jobs (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('discover','connect','greeting','verify')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','succeeded','failed','cancelled')),
 input jsonb NOT NULL, input_sha256 text NOT NULL, result jsonb NOT NULL DEFAULT '{}',
 group_id uuid REFERENCES groups(id), parent_id uuid REFERENCES group_onboarding_jobs(id),
 stage text NOT NULL DEFAULT 'queued', error_code text, attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,request_id)
);
CREATE INDEX group_onboarding_queue ON group_onboarding_jobs(status,created_at);
CREATE TABLE group_onboarding_bindings (
 native_id text PRIMARY KEY, group_id uuid NOT NULL UNIQUE REFERENCES groups(id),job_id uuid NOT NULL UNIQUE REFERENCES group_onboarding_jobs(id)
);
CREATE TABLE group_onboarding_agent (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),instance_id uuid NOT NULL,
 seen_at timestamptz NOT NULL, version text NOT NULL
);
-- Only initialize the new task default. Never change chat models or group revisions.
UPDATE model_settings SET routes=routes||jsonb_build_object('onboarding',(
 SELECT jsonb_build_object('credential_id',c.id,'model_id',m.model_id)
 FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id
 WHERE c.name='maibot-gpt' AND c.enabled AND m.model_id='gpt-6-luna' AND m.capability='text'
 ORDER BY c.created_at,c.id LIMIT 1)),revision=revision+1 WHERE NOT routes ? 'onboarding';
CREATE UNIQUE INDEX group_onboarding_one_greeting ON group_onboarding_jobs(parent_id) WHERE kind='greeting';
