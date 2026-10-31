#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/docker/groupdesk/current
export RELEASE_SHA="$(cat /opt/persist/groupdesk/release-sha)"
dc=(docker compose --env-file /opt/persist/groupdesk/secrets/app.env)
backup_dir="/opt/docker/backups/groupdesk/$(TZ=Asia/Singapore date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
"${dc[@]}" stop app worker
trap '"${dc[@]}" start app worker >/dev/null' EXIT
"${dc[@]}" exec -T --interactive=false postgres pg_dump -U groupdesk -d groupdesk -Fc > "$backup_dir/database.dump"
tar -C /opt/persist/groupdesk/files -czf "$backup_dir/files.tar.gz" .
cp /opt/persist/groupdesk/release-sha "$backup_dir/release-sha"
# The root-only backup keeps the external model encryption key for recovery.
if grep -E '^MODEL_ENCRYPTION_KEY=[[:xdigit:]]{64}$' /opt/persist/groupdesk/secrets/app.env > "$backup_dir/model-encryption.env"; then
  chmod 600 "$backup_dir/model-encryption.env"
else
  rm -f "$backup_dir/model-encryption.env"
fi
(cd "$backup_dir" && sha256sum database.dump files.tar.gz release-sha > SHA256SUMS && { if [[ -f model-encryption.env ]]; then sha256sum model-encryption.env >> SHA256SUMS; fi; })
echo "Backup created: $backup_dir"
