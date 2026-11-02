-- New enforcement must be acknowledged; keep existing tone and all other fields.
UPDATE groups
SET policy=jsonb_set(COALESCE(policy,'{}'::jsonb),'{conversation}',
 COALESCE(policy->'conversation','{"enabled":false,"banter_replies":false,"frequency":"low","instructions":""}'::jsonb)
 || '{"reply_limits":{"enabled":true,"max_rounds":2,"reset_seconds":180,"followup_seconds":180}}'::jsonb),
 revision=revision+1,applied_revision=0,bot_seen_at=NULL
WHERE NOT COALESCE((policy->'conversation') ? 'reply_limits',false);
