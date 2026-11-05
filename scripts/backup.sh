#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/docker/groupdesk/current
export RELEASE_SHA="$(cat /opt/persist/groupdesk/release-sha)"
dc=(docker compose --env-file /opt/persist/groupdesk/secrets/app.env)
backup_dir="/opt/docker/backups/groupdesk/$(TZ=Asia/Singapore date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
trap '"${dc[@]}" start app worker interaction-worker >/dev/null' EXIT
"${dc[@]}" stop interaction-worker
"${dc[@]}" stop app worker
"${dc[@]}" exec -T --interactive=false postgres pg_dump -U groupdesk -d groupdesk -Fc > "$backup_dir/database.dump"
# Freeze metadata and every robot database in the same application pause.
if [[ "$("${dc[@]}" exec -T --interactive=false postgres psql -U groupdesk -d groupdesk -Atc "SELECT to_regclass('public.managed_bots') IS NOT NULL")" == "t" ]]; then
  "${dc[@]}" exec -T --interactive=false postgres psql -U groupdesk -d groupdesk -AtF $'\t' -c "SELECT id,db_name,db_role FROM managed_bots WHERE database_state='ready' ORDER BY id" > "$backup_dir/bot-databases.tsv"
  mkdir -p "$backup_dir/bots"
  while IFS=$'\t' read -r bot_id bot_database bot_role; do
    [[ -n "$bot_id" ]] || continue
    [[ "$bot_id" =~ ^[a-f0-9-]{36}$ && "$bot_database" =~ ^gdb_[a-f0-9]{32}$ && "$bot_role" =~ ^gdr_[a-f0-9]{32}$ ]] || { echo "Invalid robot database binding"; exit 1; }
    "${dc[@]}" exec -T --interactive=false postgres pg_dump -U groupdesk -d "$bot_database" -Fc --no-owner > "$backup_dir/bots/$bot_id.dump"
  done < "$backup_dir/bot-databases.tsv"
fi
tar -C /opt/persist/groupdesk/files -czf "$backup_dir/files.tar.gz" .
cp /opt/persist/groupdesk/release-sha "$backup_dir/release-sha"
# The root-only backup keeps the external model encryption key for recovery.
if grep -E '^MODEL_ENCRYPTION_KEY=[[:xdigit:]]{64}$' /opt/persist/groupdesk/secrets/app.env > "$backup_dir/model-encryption.env"; then
  chmod 600 "$backup_dir/model-encryption.env"
else
  rm -f "$backup_dir/model-encryption.env"
fi
(cd "$backup_dir" && sha256sum database.dump files.tar.gz release-sha > SHA256SUMS && { if [[ -f model-encryption.env ]]; then sha256sum model-encryption.env >> SHA256SUMS; fi; })
if [[ -f "$backup_dir/bot-databases.tsv" ]]; then
  (cd "$backup_dir" && sha256sum bot-databases.tsv >> SHA256SUMS && find bots -type f -name '*.dump' -exec sha256sum {} \; >> SHA256SUMS)
fi
echo "Backup created: $backup_dir"
