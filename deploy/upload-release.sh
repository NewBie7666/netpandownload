#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ && "$DEPLOY_PORT" -ge 1 && "$DEPLOY_PORT" -le 65535 ]]
[[ "$DEPLOY_USER" == netpan-deploy ]]
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ && "$DEPLOY_CHECKSUM" =~ ^[0-9a-f]{64}$ ]]
[[ -n "$DEPLOY_KEY" && -n "$DEPLOY_KNOWN_HOSTS" ]]
[[ "$NETPAN_TEST_BASE_URL" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
[[ -n "$NETPAN_TEST_BASIC_USER" && -n "$NETPAN_TEST_BASIC_PASSWORD" ]]
mkdir -p reports
archive=".release/netpan-$DEPLOY_SHA.tar.gz"
printf '%s  %s\n' "$DEPLOY_CHECKSUM" "$archive" | sha256sum -c -
umask 077
temp_dir=$(mktemp -d "$RUNNER_TEMP/netpan-ssh.XXXXXX")
cleanup() { rm -f -- "$temp_dir/key" "$temp_dir/known_hosts"; rmdir -- "$temp_dir"; }
trap cleanup EXIT
printf '%s\n' "$DEPLOY_KEY" > "$temp_dir/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$temp_dir/known_hosts"
unset DEPLOY_KEY DEPLOY_KNOWN_HOSTS
common=(-i "$temp_dir/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$temp_dir/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
target="$DEPLOY_USER@$DEPLOY_HOST"
remote="/opt/netpandownload/.staging/netpan-$DEPLOY_SHA.tar.gz"
# No production filesystem or service initialization is performed by CI.
ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "test -x /usr/local/libexec/netpan-release.py && test -d /opt/netpandownload/.staging && test ! -L /opt/netpandownload/.staging && test ! -e '$remote' && test ! -L '$remote'"
scp "${common[@]}" -P "$DEPLOY_PORT" "$archive" "$target:$remote"
ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "set -o pipefail; /usr/local/libexec/netpan-release.py deploy --sha '$DEPLOY_SHA' --archive '$remote' --checksum '$DEPLOY_CHECKSUM' 2>&1 | tee /opt/netpandownload/logs/$DEPLOY_SHA-$GITHUB_RUN_ID.log" 2>&1 | tee reports/production-release.txt
# Verify public HTTPS certificate, Basic authentication, identity and RPC.
# If public health fails, revert the server release too (including first deployment).
if ! node deploy/public-smoke.mjs; then
  ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "/usr/local/libexec/netpan-release.py undo --sha '$DEPLOY_SHA'" 2>&1 | tee reports/public-health-rollback.txt
  exit 1
fi
printf 'Release %s passed protected HTTPS smoke checks.\n' "$DEPLOY_SHA" >> "$GITHUB_STEP_SUMMARY"
