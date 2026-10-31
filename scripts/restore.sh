#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 2 && "$2" == "--replace-current-data" ]] || { echo "Usage: restore.sh /absolute/backup/directory --replace-current-data"; exit 1; }
backup_dir="$(realpath "$1")"
[[ "$backup_dir" == /opt/docker/backups/groupdesk/* ]] || { echo "Use a trusted GroupDesk backup directory"; exit 1; }
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
cd /opt/docker/groupdesk/current
export RELEASE_SHA="$(cat /opt/persist/groupdesk/release-sha)"
dc=(docker compose --env-file /opt/persist/groupdesk/secrets/app.env)
"${dc[@]}" stop app worker
# On failure remain stopped rather than serving partially restored data.
"${dc[@]}" exec -T postgres pg_restore -U groupdesk -d groupdesk --clean --if-exists --exit-on-error < "$backup_dir/database.dump"
restore_dir="$(mktemp -d /opt/persist/groupdesk/restore-files.XXXXXX)"
tar -xzf "$backup_dir/files.tar.gz" -C "$restore_dir"
chown -R 1000:1000 "$restore_dir"
mv /opt/persist/groupdesk/files "/opt/persist/groupdesk/files.before-restore-$(date +%s)"
mv "$restore_dir" /opt/persist/groupdesk/files
"${dc[@]}" up -d --no-build --force-recreate --no-deps --wait --wait-timeout 150 app worker
echo "Restore complete. Previous files remain in files.before-restore-*."
