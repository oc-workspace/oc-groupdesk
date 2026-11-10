-- Freeze the former effective selection in summary_settings. Keep all
-- settings revisions, tasks, plans and original group/default JSON intact.
-- Missing settings use revision zero, preserving outstanding preview tokens.
WITH choices AS (
 SELECT g.id, s.revision, s.config, s.last_adapter_seen,
  CASE WHEN g.model_routes#>>'{text,mode}'='disabled' THEN NULL
   WHEN g.model_routes#>>'{stages,summary,mode}'='custom' THEN g.model_routes#>'{stages,summary}'
   WHEN NULLIF(m.routes#>'{stages,summary}','null'::jsonb) IS NOT NULL THEN m.routes#>'{stages,summary}'
   WHEN g.model_routes#>>'{text,mode}'='custom' THEN g.model_routes->'text'
   ELSE NULLIF(m.routes->'text','null'::jsonb) END AS selection
 FROM groups g CROSS JOIN model_settings m LEFT JOIN summary_settings s ON s.group_id=g.id
 WHERE m.singleton=true AND g.deleted_at IS NULL
  AND (s.group_id IS NULL OR COALESCE(s.config#>>'{model_route,mode}','inherit')='inherit')
)
INSERT INTO summary_settings(group_id,revision,config,last_adapter_seen)
SELECT id,COALESCE(revision,0),jsonb_set(
 COALESCE(config,'{"enabled":false,"timezone":"Asia/Shanghai","template":"comprehensive","language":"group","instructions":"","input_character_budget":60000}'::jsonb),
 '{model_route}',CASE WHEN selection IS NULL THEN '{"mode":"unconfigured"}'::jsonb ELSE
 jsonb_build_object('mode','custom','credential_id',selection->'credential_id','model_id',selection->'model_id') END,true),last_adapter_seen
FROM choices
ON CONFLICT(group_id) DO UPDATE SET config=EXCLUDED.config;
