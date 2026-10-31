#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
[[ "$repo_root" == /opt/docker/for-oc-dev2prod/oc-groupdesk ]] || { echo "Use the isolated production bridge checkout"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Working tree must be clean"; exit 1; }
[[ "$(git remote get-url prod)" == *oWinnieo/oc-groupdesk.git ]] || { echo "Unexpected prod remote"; exit 1; }
git fetch prod main
release_sha="$(git rev-parse refs/remotes/prod/main)"
release_dir="/opt/docker/groupdesk/releases/$release_sha"
if [[ ! -d "$release_dir" ]]; then
  mkdir -p "$release_dir"
  git archive "$release_sha" | tar -x -C "$release_dir"
fi
export RELEASE_SHA="$release_sha"
env_file="/opt/persist/groupdesk/secrets/app.env"
[[ -f "$env_file" ]] || { echo "Initialize external secrets first"; exit 1; }
cd "$release_dir"
docker compose --env-file "$env_file" config --quiet
docker compose --env-file "$env_file" build app
docker compose --env-file "$env_file" up -d --no-build --wait --wait-timeout 150
ln -sfn "$release_dir" /opt/docker/groupdesk/current
printf '%s\n' "$release_sha" > /opt/persist/groupdesk/release-sha
echo "Deployed production commit: $release_sha"
