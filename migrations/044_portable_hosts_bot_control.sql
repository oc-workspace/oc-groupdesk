-- Existing registrations and credentials are preserved on upgrade.
ALTER TABLE managed_runtime_hosts DROP CONSTRAINT IF EXISTS managed_runtime_hosts_id_check;
ALTER TABLE managed_runtime_hosts ADD CONSTRAINT managed_runtime_hosts_id_check CHECK(id ~ '^[a-z0-9][a-z0-9-]{0,62}$');
