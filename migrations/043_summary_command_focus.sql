ALTER TABLE summary_jobs DROP CONSTRAINT summary_jobs_trigger_mode;
UPDATE summary_jobs SET trigger_mode='legacy_today' WHERE trigger_kind='group_command' AND trigger_mode='today';
ALTER TABLE summary_jobs ADD CONSTRAINT summary_jobs_trigger_mode CHECK (
  trigger_mode IS NULL OR trigger_mode IN ('previous_day','today','previous_day_focus','today_focus','legacy_today')
);
