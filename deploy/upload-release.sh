#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ && "$DEPLOY_PORT" -ge 1 && "$DEPLOY_PORT" -le 65535 ]]
[[ "$DEPLOY_USER" == netpan-deploy ]]
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ && "$DEPLOY_CHECKSUM" =~ ^[0-9a-f]{64}$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]
[[ -n "$DEPLOY_KEY" && -n "$DEPLOY_KNOWN_HOSTS" ]]
[[ "$NETPAN_TEST_BASE_URL" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
[[ -n "$NETPAN_TEST_BASIC_USER" && -n "$NETPAN_TEST_BASIC_PASSWORD" ]]
mkdir -p reports
archive=".release/netpan-$DEPLOY_SHA.tar.gz"
printf '%s  %s\n' "$DEPLOY_CHECKSUM" "$archive" | sha256sum -c -
umask 077
temp_dir=$(mktemp -d "$RUNNER_TEMP/netpan-ssh.XXXXXX")
remote_upload_dir=
child_pids=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${child_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${child_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  if [[ "$remote_upload_dir" =~ ^/opt/netpandownload/\.staging/netpan-upload-[0-9a-f]{40}-[0-9]+\.[A-Za-z0-9]{6}$ ]]; then
    ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" \
      "rm -f -- '$remote_upload_dir/chunk-00' '$remote_upload_dir/chunk-01' '$remote_upload_dir/chunk-02' '$remote_upload_dir/chunk-03' '$remote_upload_dir/archive.tmp'; rmdir -- '$remote_upload_dir'" \
      >/dev/null 2>&1 || true
  fi
  rm -f -- "$temp_dir"/chunk-00 "$temp_dir"/chunk-01 "$temp_dir"/chunk-02 "$temp_dir"/chunk-03 \
    "$temp_dir/key" "$temp_dir/known_hosts" "$temp_dir"/scp-00.log "$temp_dir"/scp-01.log \
    "$temp_dir"/scp-02.log "$temp_dir"/scp-03.log
  rmdir -- "$temp_dir" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' INT TERM
printf '%s\n' "$DEPLOY_KEY" > "$temp_dir/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$temp_dir/known_hosts"
unset DEPLOY_KEY DEPLOY_KNOWN_HOSTS
common=(-i "$temp_dir/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$temp_dir/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
target="$DEPLOY_USER@$DEPLOY_HOST"
remote="/opt/netpandownload/.staging/netpan-$DEPLOY_SHA.tar.gz"
# No production filesystem or service initialization is performed by CI.
ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "test -x /usr/local/libexec/netpan-release.py && test -d /opt/netpandownload/.staging && test ! -L /opt/netpandownload/.staging && test ! -e '$remote' && test ! -L '$remote'"
remote_upload_dir=$(ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" \
  "umask 077; d=\$(mktemp -d -- '/opt/netpandownload/.staging/netpan-upload-${DEPLOY_SHA}-${GITHUB_RUN_ID}.XXXXXX'); test \"\${d#'/opt/netpandownload/.staging/netpan-upload-${DEPLOY_SHA}-${GITHUB_RUN_ID}.'}\" != \"\${d}\"; printf '%s\\n' \"\$d\"")
[[ "$remote_upload_dir" =~ ^/opt/netpandownload/\.staging/netpan-upload-${DEPLOY_SHA}-${GITHUB_RUN_ID}\.[A-Za-z0-9]{6}$ ]]
split -n 4 -d -a 2 -- "$archive" "$temp_dir/chunk-"
chunks=("$temp_dir/chunk-00" "$temp_dir/chunk-01" "$temp_dir/chunk-02" "$temp_dir/chunk-03")
for chunk in "${chunks[@]}"; do [[ -f "$chunk" && ! -L "$chunk" ]]; done
echo 'Uploading verified release in four parallel chunks'
for index in 00 01 02 03; do
  scp "${common[@]}" -P "$DEPLOY_PORT" "$temp_dir/chunk-$index" "$target:$remote_upload_dir/chunk-$index" \
    >"$temp_dir/scp-$index.log" 2>&1 &
  child_pids+=("$!")
done
upload_failed=0
for pid in "${child_pids[@]}"; do
  if ! wait "$pid"; then upload_failed=1; fi
done
child_pids=()
if (( upload_failed != 0 )); then
  echo 'Release chunk upload failed; no release switch attempted' >&2
  exit 1
fi
echo 'Reassembling and verifying complete archive on server'
ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" \
  "set -eu; for part in 00 01 02 03; do test -f '$remote_upload_dir/chunk-'\$part; done; cat '$remote_upload_dir/chunk-00' '$remote_upload_dir/chunk-01' '$remote_upload_dir/chunk-02' '$remote_upload_dir/chunk-03' > '$remote_upload_dir/archive.tmp'; printf '%s  %s\\n' '$DEPLOY_CHECKSUM' '$remote_upload_dir/archive.tmp' | sha256sum -c - >/dev/null; test ! -e '$remote' && test ! -L '$remote'; mv -T -n -- '$remote_upload_dir/archive.tmp' '$remote'; test ! -e '$remote_upload_dir/archive.tmp'; test -f '$remote'"
ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "set -o pipefail; /usr/local/libexec/netpan-release.py deploy --sha '$DEPLOY_SHA' --archive '$remote' --checksum '$DEPLOY_CHECKSUM' 2>&1 | tee /opt/netpandownload/logs/$DEPLOY_SHA-$GITHUB_RUN_ID.log" 2>&1 | tee reports/production-release.txt
# Verify public HTTPS certificate, Basic authentication, identity and RPC.
# If public health fails, revert the server release too (including first deployment).
if ! node deploy/public-smoke.mjs; then
  ssh "${common[@]}" -p "$DEPLOY_PORT" "$target" "/usr/local/libexec/netpan-release.py undo --sha '$DEPLOY_SHA'" 2>&1 | tee reports/public-health-rollback.txt
  exit 1
fi
printf 'Release %s passed protected HTTPS smoke checks.\n' "$DEPLOY_SHA" >> "$GITHUB_STEP_SUMMARY"
