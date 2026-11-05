#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 2 && "$2" == "--replace-current-data" ]] || { echo "Usage: restore.sh /absolute/backup/directory --replace-current-data"; exit 1; }
backup_dir="$(realpath "$1")"
[[ "$backup_dir" == /opt/docker/backups/groupdesk/* ]] || { echo "Use a trusted GroupDesk backup directory"; exit 1; }
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
if [[ -f "$backup_dir/model-encryption.env" ]]; then
  model_key_line="$(grep -E '^MODEL_ENCRYPTION_KEY=[[:xdigit:]]{64}$' /opt/persist/groupdesk/secrets/app.env || true)"
  [[ "$model_key_line" == "$(cat "$backup_dir/model-encryption.env")" ]] || { echo "Restore the matching MODEL_ENCRYPTION_KEY from this root-only backup to external app.env first"; exit 1; }
  unset model_key_line
fi
cd /opt/docker/groupdesk/current
export RELEASE_SHA="$(cat /opt/persist/groupdesk/release-sha)"
dc=(docker compose --env-file /opt/persist/groupdesk/secrets/app.env)
"${dc[@]}" stop interaction-worker
"${dc[@]}" stop app worker
# On failure remain stopped rather than serving partially restored data.
"${dc[@]}" exec -T postgres pg_restore -U groupdesk -d groupdesk --no-owner --no-acl --clean --if-exists --exit-on-error < "$backup_dir/database.dump"
if [[ -f "$backup_dir/bot-databases.tsv" ]]; then
  "${dc[@]}" run --rm --no-deps -T -e GROUPDESK_RESTORE_MODE=1 worker /app/node_modules/.bin/tsx scripts/prepare-bot-restore.ts
  while IFS=$'\t' read -r bot_id bot_database bot_role; do
    [[ -n "$bot_id" ]] || continue
    [[ "$bot_id" =~ ^[a-f0-9-]{36}$ && "$bot_database" =~ ^gdb_[a-f0-9]{32}$ && "$bot_role" =~ ^gdr_[a-f0-9]{32}$ ]] || { echo "Invalid robot database binding"; exit 1; }
    [[ -f "$backup_dir/bots/$bot_id.dump" ]] || { echo "Missing robot database backup"; exit 1; }
    "${dc[@]}" exec -T postgres pg_restore -U groupdesk -d "$bot_database" --role="$bot_role" --no-owner --no-acl --clean --if-exists --exit-on-error < "$backup_dir/bots/$bot_id.dump"
  done < "$backup_dir/bot-databases.tsv"
fi
restore_dir="$(mktemp -d /opt/persist/groupdesk/restore-files.XXXXXX)"
tar -xzf "$backup_dir/files.tar.gz" -C "$restore_dir"
chown -R 1000:1000 "$restore_dir"
mv /opt/persist/groupdesk/files "/opt/persist/groupdesk/files.before-restore-$(date +%s)"
mv "$restore_dir" /opt/persist/groupdesk/files
"${dc[@]}" up -d --no-build --force-recreate --no-deps --wait --wait-timeout 150 app worker interaction-worker
echo "Robots restored from a multi-robot backup remain paused until explicitly activated."
echo "Restore complete. Previous files remain in files.before-restore-*."
