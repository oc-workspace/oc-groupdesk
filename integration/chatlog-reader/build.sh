#!/usr/bin/env bash
# Prepared, hash-verified public inputs only. No WeChat data is mounted.
set -euo pipefail
cd "$(dirname "$0")"
test "$(docker image inspect wechat-bot-base:4.1.13.23-selkies0.0.17 --format '{{.Id}}')" = 'sha256:3aaa32335e65e5a39dffbea0781f8dae99e5f664a47f4ebc6816e2f00c2a4ded'
docker build --pull=false --network none -f Dockerfile.bootstrap -t "chatlog-bootstrap:${1:?Set the source revision}" .
