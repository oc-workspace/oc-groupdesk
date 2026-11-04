ALTER TABLE summary_jobs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}';
CREATE TABLE summary_source_batches (
 job_id uuid NOT NULL REFERENCES summary_jobs(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal>=0),
 messages jsonb NOT NULL,
 digest text NOT NULL,
 PRIMARY KEY(job_id,ordinal)
);
