ALTER TABLE persona_datasets ADD COLUMN contains_any text[] NOT NULL DEFAULT '{}';
CREATE TABLE conversation_jobs (
 id uuid PRIMARY KEY,dataset_id uuid NOT NULL REFERENCES persona_datasets(id),
 credential_id uuid NOT NULL REFERENCES model_credentials(id),credential_revision integer NOT NULL,
 model_id text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed')),
 input jsonb NOT NULL,provenance jsonb NOT NULL,error text,
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz
);
CREATE UNIQUE INDEX conversation_one_active ON conversation_jobs(dataset_id) WHERE status IN ('pending','processing');
CREATE TABLE conversation_labels (
 dataset_id uuid NOT NULL REFERENCES persona_datasets(id),collection_id uuid NOT NULL,source_id text NOT NULL,
 content_hash text NOT NULL,tone text NOT NULL CHECK(tone IN ('serious','playful','mixed','uncertain')),
 substantive boolean,confidence real NOT NULL CHECK(confidence>=0 AND confidence<=1),reason text NOT NULL,
 manual boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,
 job_id uuid REFERENCES conversation_jobs(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(dataset_id,collection_id,source_id),
 FOREIGN KEY(collection_id,source_id) REFERENCES persona_materials(collection_id,source_id)
);
