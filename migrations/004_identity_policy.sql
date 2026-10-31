-- Optional contract-v1 extension. Preserve existing settings and invalidate old leases.
UPDATE groups
SET policy=jsonb_set(
    COALESCE(policy,'{}'::jsonb),'{identity}',
    '{"disclosure":"when_asked","personal_questions":"tactful"}'::jsonb
  ),
  revision=revision+1
WHERE NOT (COALESCE(policy,'{}'::jsonb) ? 'identity');
