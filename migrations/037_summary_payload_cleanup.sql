-- Cancelled tasks keep only their minimal history/deduplication metadata.
-- A row trigger makes all existing cancellation paths clean up atomically.
CREATE OR REPLACE FUNCTION clear_cancelled_summary_payload() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='cancelled' THEN
  DELETE FROM summary_parts WHERE job_id=NEW.id;
  DELETE FROM summary_source_batches WHERE job_id=NEW.id;
  NEW.report:=NULL; NEW.source:=NULL; NEW.config:='{}'::jsonb;
  NEW.template:='{}'::jsonb; NEW.progress:='{}'::jsonb;
  NEW.source_token:=NULL; NEW.delivery_token:=NULL; NEW.lease_until:=NULL;
  NEW.finished_at:=COALESCE(NEW.finished_at,now());
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS summary_jobs_cancelled_payload_cleanup ON summary_jobs;
CREATE TRIGGER summary_jobs_cancelled_payload_cleanup
 BEFORE INSERT OR UPDATE ON summary_jobs
 FOR EACH ROW EXECUTE FUNCTION clear_cancelled_summary_payload();
UPDATE summary_jobs SET report=NULL
 WHERE status='cancelled' AND (report IS NOT NULL OR source IS NOT NULL
 OR config<>'{}'::jsonb OR template<>'{}'::jsonb OR progress<>'{}'::jsonb
 OR source_token IS NOT NULL OR delivery_token IS NOT NULL OR lease_until IS NOT NULL
 OR finished_at IS NULL OR EXISTS(SELECT 1 FROM summary_parts p WHERE p.job_id=summary_jobs.id)
 OR EXISTS(SELECT 1 FROM summary_source_batches b WHERE b.job_id=summary_jobs.id));
-- 036 already froze the effective model in summary_settings. Remove only the
-- retired JSON item; active chat stages and current summary settings remain.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE name='036_summary_model_single_entry.sql') THEN
  RAISE EXCEPTION 'Apply 036_summary_model_single_entry.sql before cleanup';
 END IF;
END $$;
UPDATE groups SET model_routes=CASE
 WHEN (model_routes#-'{stages,summary}')->'stages'='{}'::jsonb
 THEN (model_routes#-'{stages,summary}')-'stages'
 ELSE model_routes#-'{stages,summary}' END
 WHERE (model_routes->'stages') ? 'summary';
UPDATE model_settings SET routes=CASE
 WHEN (routes#-'{stages,summary}')->'stages'='{}'::jsonb
 THEN (routes#-'{stages,summary}')-'stages'
 ELSE routes#-'{stages,summary}' END
 WHERE (routes->'stages') ? 'summary';
