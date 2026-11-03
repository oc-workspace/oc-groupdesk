-- Timeout contract v3 includes the actual answer-generation task. Preserve
-- smaller existing provider/turn budgets by deriving a compatible default.
UPDATE groups
SET policy=jsonb_set(COALESCE(policy,'{}'::jsonb),'{timeouts}',
 '{"planner_seconds":300,"request_seconds":310,"direct_ttl_seconds":420,"wait_apology_seconds":300}'::jsonb
 || COALESCE(policy->'timeouts','{}'::jsonb)
 || jsonb_build_object('replyer_seconds',LEAST(300,GREATEST(30,COALESCE((policy->'timeouts'->>'request_seconds')::integer,310)-10)))),
 revision=revision+1,applied_revision=0,bot_seen_at=NULL
WHERE NOT COALESCE((policy->'timeouts') ? 'replyer_seconds',false);
