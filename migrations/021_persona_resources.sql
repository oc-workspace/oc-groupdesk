CREATE TABLE persona_resource_previews (
 id uuid PRIMARY KEY,
 resource_id text NOT NULL,
 snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON persona_resource_previews(created_at);
CREATE TABLE persona_resource_imports (
 id uuid PRIMARY KEY,
 resource_id text NOT NULL,
 repository text NOT NULL,
 source_path text NOT NULL,
 source_commit text NOT NULL,
 source_sha256 text NOT NULL,
 snapshot jsonb NOT NULL,
 collection_id uuid NOT NULL REFERENCES persona_collections(id),
 dataset_id uuid NOT NULL REFERENCES persona_datasets(id),
 persona_id uuid REFERENCES personas(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(repository,source_path)
);
