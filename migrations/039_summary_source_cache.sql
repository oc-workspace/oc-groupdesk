-- Complete Reader windows only. A cache row is written after source totals
-- and every batch have been verified; unfinished uploads never enter here.
CREATE TABLE summary_source_cache (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 external_id text NOT NULL,
 window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL,
 origin text NOT NULL CHECK (origin='wechat-database-chatlog-keeper'),
 messages jsonb NOT NULL,
 source_epoch text,
 source_through bigint,
 fetched_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK (window_start<window_end),
 CHECK (expires_at>fetched_at),
 UNIQUE (group_id,external_id,window_start,window_end,origin)
);
CREATE INDEX summary_source_cache_lookup
 ON summary_source_cache(group_id,external_id,expires_at,window_start,window_end);
