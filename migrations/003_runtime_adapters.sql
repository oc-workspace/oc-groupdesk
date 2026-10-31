CREATE TABLE runtime_adapters (
  token_hash text PRIMARY KEY,
  name text NOT NULL,
  group_external_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
