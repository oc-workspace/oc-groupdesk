ALTER TABLE topics ADD COLUMN policy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE topics ADD COLUMN catalog_key text UNIQUE;
ALTER TABLE topics ADD COLUMN catalog_version integer;
ALTER TABLE topics ADD COLUMN catalog_hash text;
ALTER TABLE topics ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN policy jsonb NOT NULL DEFAULT '{}';
CREATE TABLE catalog_imports (name text PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now());
