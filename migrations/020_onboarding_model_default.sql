-- User requested gpt-5.5 after gpt-6-luna returned 503. Only adjust the helper.
-- Keep independently chosen credentials/models and every group/chat setting.
UPDATE model_settings s SET routes=jsonb_set(s.routes,'{onboarding}',jsonb_build_object('credential_id',c.id,'model_id','gpt-5.5')),revision=s.revision+1
FROM model_credentials c JOIN credential_models m ON m.credential_id=c.id AND m.model_id='gpt-5.5' AND m.capability='text'
WHERE c.name='maibot-gpt' AND c.enabled AND (s.routes->'onboarding' IS NULL OR s.routes->'onboarding'='null'::jsonb OR (s.routes->'onboarding'->>'credential_id'=c.id::text AND s.routes->'onboarding'->>'model_id'='gpt-6-luna'));
