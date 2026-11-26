ALTER TABLE groups ADD COLUMN IF NOT EXISTS request_status jsonb NOT NULL DEFAULT '[]';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS request_status_at timestamptz;
