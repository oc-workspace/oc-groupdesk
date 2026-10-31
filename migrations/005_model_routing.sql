CREATE TABLE model_credentials (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE, base_url text NOT NULL,
 key_ciphertext text NOT NULL, key_hint text NOT NULL, key_digest text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 catalog_synced_at timestamptz, catalog_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(base_url,key_digest)
);
CREATE TABLE credential_models (
 credential_id uuid NOT NULL REFERENCES model_credentials(id) ON DELETE CASCADE,
 model_id text NOT NULL, display_name text NOT NULL,
 capability text NOT NULL CHECK(capability IN ('text','image','other','unknown')),
 source text NOT NULL CHECK(source IN ('catalog','manual','configured')),
 listed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(credential_id,model_id)
);
CREATE TABLE model_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision integer NOT NULL DEFAULT 1,
 routes jsonb NOT NULL DEFAULT '{"text":null,"image":null}'
);
INSERT INTO model_settings(singleton) VALUES(true);
ALTER TABLE groups ADD COLUMN model_routes jsonb NOT NULL DEFAULT '{"text":{"mode":"inherit"},"image":{"mode":"inherit"}}';
