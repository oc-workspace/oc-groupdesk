CREATE TABLE persona_collections (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE,
 group_id uuid REFERENCES groups(id), external_group_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE persona_imports (
 id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES persona_collections(id),
 name text NOT NULL, format text NOT NULL, sha256 text NOT NULL, filename text NOT NULL,
 added integer NOT NULL DEFAULT 0, updated integer NOT NULL DEFAULT 0,
 unchanged integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(collection_id,sha256)
);
CREATE TABLE persona_materials (
 collection_id uuid NOT NULL REFERENCES persona_collections(id), source_id text NOT NULL,
 sender_id text NOT NULL, sender_name text NOT NULL, timestamp bigint NOT NULL DEFAULT 0,
 authored_text text, quoted_context jsonb, shared_content jsonb,
 kind text NOT NULL, content_status text NOT NULL, source jsonb NOT NULL,
 content_hash text NOT NULL, excluded boolean NOT NULL DEFAULT false,
 import_id uuid NOT NULL REFERENCES persona_imports(id),
 PRIMARY KEY(collection_id,source_id)
);
CREATE INDEX persona_material_sender ON persona_materials(collection_id,sender_id,timestamp,source_id);
CREATE TABLE persona_datasets (
 id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES persona_collections(id),
 name text NOT NULL, sender_ids text[] NOT NULL DEFAULT '{}',
 since bigint, until_time bigint, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(since IS NULL OR until_time IS NULL OR since<=until_time)
);
CREATE TABLE personas (
 id uuid PRIMARY KEY, name text NOT NULL, skill_name text NOT NULL UNIQUE, description text NOT NULL DEFAULT '',
 goal text NOT NULL DEFAULT '', dataset_ids uuid[] NOT NULL DEFAULT '{}',
 draft_skill text NOT NULL DEFAULT '', draft_provenance jsonb NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE persona_versions (
 id uuid PRIMARY KEY, persona_id uuid NOT NULL REFERENCES personas(id), version integer NOT NULL,
 skill_md text NOT NULL, sha256 text NOT NULL, provenance jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(persona_id,version)
);
ALTER TABLE groups ADD COLUMN persona_version_id uuid REFERENCES persona_versions(id);
CREATE TABLE persona_jobs (
 id uuid PRIMARY KEY, persona_id uuid NOT NULL REFERENCES personas(id), draft_revision integer NOT NULL,
 credential_id uuid NOT NULL REFERENCES model_credentials(id), credential_revision integer NOT NULL,
 model_id text NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','processing','ready','failed','conflict')),
 input_file text NOT NULL, provenance jsonb NOT NULL, output_skill text, error text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX persona_one_active_job ON persona_jobs(persona_id) WHERE status IN ('pending','processing');
