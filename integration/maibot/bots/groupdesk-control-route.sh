#!/bin/bash
set -euo pipefail
state=/var/lib/groupdesk-control-route/ipv4
mkdir -p /var/lib/groupdesk-control-route
chmod 0700 /var/lib/groupdesk-control-route
new=$(getent ahostsv4 groupdesk.rococo.dev | awk '$2=="STREAM" {print $1}' | sort -u)
[ -n "$new" ] || exit 1
old=$(cat "$state" 2>/dev/null || true)
for ip in $new; do
  if ! ip -4 rule show | grep -Eq "^8994:.*to ${ip}(/32)? lookup main$"; then
    ip -4 rule add priority 8994 to "$ip/32" lookup main
  fi
done
for ip in $old; do
  if ! printf '%s\n' "$new" | grep -Fxq "$ip"; then
    ip -4 rule del priority 8994 to "$ip/32" lookup main || true
  fi
done
printf '%s\n' "$new" > "$state"
chmod 0600 "$state"
# The control server also has an IPv6 address. Keep a destination-scoped
# bypass for the local relay; the Pi's ordinary IPv6 policy is unreachable.
control_v6=2a0a:4cc0:2000:2be0:d83e:47ff:fe76:2d9
if ! ip -6 rule show | grep -Eq "^8994:.*to ${control_v6}(/128)? lookup main$"; then
  ip -6 rule add priority 8994 to "$control_v6/128" lookup main
fi
