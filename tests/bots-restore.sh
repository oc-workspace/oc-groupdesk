#!/usr/bin/env bash
# Destructive operations here apply only to this randomly named tmpfs test cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
project="groupdesk-restore-test-$$"
work="$(mktemp -d)"
chmod 755 "$work"
mkdir "$work/files"
chmod 777 "$work/files"
dc=(docker compose -p "$project" -f compose.test.yaml)
cleanup(){ "${dc[@]}" down --remove-orphans >/dev/null; rm -rf "$work"; }
trap cleanup EXIT
"${dc[@]}" up -d --wait postgres-test
run(){ "${dc[@]}" run --rm -T --no-deps -v "$work/files:/tmp/groupdesk-test-data" test "$@"; }
run ./node_modules/.bin/tsx tests/bots-restore-fixture.ts setup
"${dc[@]}" exec -T postgres-test pg_dump -U postgres -d groupdesk_test -Fc > "$work/control.dump"
"${dc[@]}" exec -T postgres-test psql -U postgres -d groupdesk_test -AtF $'\t' -c "SELECT id,db_name,db_role FROM managed_bots WHERE database_state='ready'" > "$work/databases.tsv"
while IFS=$'\t' read -r bot_id database role; do
  "${dc[@]}" exec -T postgres-test pg_dump -U postgres -d "$database" -Fc --no-owner > "$work/$bot_id.dump"
done < "$work/databases.tsv"
run ./node_modules/.bin/tsx tests/bots-restore-fixture.ts destroy
"${dc[@]}" exec -T postgres-test pg_restore -U postgres -d groupdesk_test --no-owner --no-acl --clean --if-exists --exit-on-error < "$work/control.dump"
run env GROUPDESK_RESTORE_MODE=1 ./node_modules/.bin/tsx scripts/prepare-bot-restore.ts
while IFS=$'\t' read -r bot_id database role; do
  "${dc[@]}" exec -T postgres-test pg_restore -U postgres -d "$database" --role="$role" --no-owner --no-acl --clean --if-exists --exit-on-error < "$work/$bot_id.dump"
done < "$work/databases.tsv"
run ./node_modules/.bin/tsx tests/bots-restore-fixture.ts verify
