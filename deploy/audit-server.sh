#!/usr/bin/env bash
# Read-only; administrator reviews output privately. Never prints nginx -T or env secrets.
set -euo pipefail
printf '== OS / architecture ==\n'
cat /etc/os-release
uname -m
printf '== space ==\n'
df -h / /opt /srv
printf '== listeners ==\n'
ss -ltn
printf '== dependency versions ==\n'
for name in node aria2c yt-dlp gallery-dl nginx; do
  command -v "$name" || true
done
node --version 2>/dev/null || true
aria2c --version 2>/dev/null | head -n 1 || true
printf '== nginx syntax / site names (no full config or credentials) ==\n'
nginx -t
find /etc/nginx/sites-enabled -maxdepth 1 -type l -printf '%f -> %l\n'
printf '== existing project release ==\n'
readlink -e /var/www/immune-arena/current || true
printf '== netpan units ==\n'
systemctl is-active nginx netpan-web netpan-aria2 || true
printf '== SSH server public ED25519 fingerprint ==\n'
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
