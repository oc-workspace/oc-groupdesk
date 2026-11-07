ALTER TABLE model_credentials ADD COLUMN vault_key_id uuid;
CREATE UNIQUE INDEX ON model_credentials(vault_key_id) WHERE vault_key_id IS NOT NULL;
