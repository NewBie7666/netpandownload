#!/usr/bin/env bash
# Administrator-only one-time setup, after actual host/TLS/quota audit.
set -Eeuo pipefail
trap 'echo "Initialization stopped. Existing sites were not overwritten. Review NetPan-only partial state before retrying; do not remove existing project files." >&2' ERR
[[ $EUID == 0 ]] || { echo 'Run once as administrator after review' >&2; exit 1; }
[[ $# == 6 ]] || { echo 'Usage: bootstrap.sh DOMAIN FULLCHAIN PRIVKEY DEPLOY_PUBLIC_KEY HTPASSWD_FILE QUOTA_MOUNT' >&2; exit 1; }
domain=$1 cert=$2 key=$3 pubkey=$4 passwd=$5 quota_mount=$6
[[ "$domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || exit 1
for file in "$cert" "$key" "$pubkey" "$passwd"; do [[ "$file" == /* && -f "$file" ]] || exit 1; done
[[ "$cert" =~ ^/[A-Za-z0-9/_.-]+$ && "$key" =~ ^/[A-Za-z0-9/_.-]+$ ]] || exit 1
# Require a dedicated bounded filesystem for downloads; never fill the host root disk.
[[ "$quota_mount" == /srv/netpandownload && -d "$quota_mount" && ! -L "$quota_mount" ]]
mountpoint -q "$quota_mount" || { echo 'Prepare a dedicated, capacity-limited /srv/netpandownload mount first' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'Current release targets Linux x86_64 only' >&2; exit 1; }
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == debian || "${ID:-}" == ubuntu ]] || { echo 'Review bootstrap for the detected distribution first' >&2; exit 1; }
for port in 3300 16801; do
  [[ -z $(ss -H -ltn "sport = :$port") ]] || { echo "Port $port is already occupied" >&2; exit 1; }
done
[[ -x /usr/bin/node && $(/usr/bin/node --version) == v22.23.4 ]] || { echo 'Install reviewed Node 22.23.4 at /usr/bin/node first' >&2; exit 1; }
for cmd in aria2c nginx openssl python3 htpasswd visudo systemctl; do command -v "$cmd" >/dev/null; done
[[ -x /usr/local/bin/yt-dlp && -x /usr/local/bin/gallery-dl ]]
nginx -t
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
python3 "$script_dir/check-domain.py" "$domain"
# Fail rather than overwrite an existing setup or another application's account.
for account in netpan netpan-deploy; do ! getent passwd "$account" >/dev/null || { echo "Account already exists: $account; review manually" >&2; exit 1; }; done
for dest in /opt/netpandownload /etc/netpandownload /etc/nginx/netpandownload.htpasswd /etc/nginx/sites-available/netpandownload.conf /etc/nginx/sites-enabled/netpandownload.conf /etc/systemd/system/netpan-web.service /etc/systemd/system/netpan-aria2.service /etc/sudoers.d/netpan-deploy /usr/local/libexec/netpan-release.py /usr/local/libexec/netpan-start /usr/local/libexec/netpan-health; do
  [[ ! -e "$dest" && ! -L "$dest" ]] || { echo "Refusing to overwrite $dest" >&2; exit 1; }
done
openssl x509 -in "$cert" -noout -checkend 604800 >/dev/null
openssl x509 -in "$cert" -noout -checkhost "$domain" >/dev/null
openssl verify -CApath /etc/ssl/certs -untrusted "$cert" -verify_hostname "$domain" "$cert" >/dev/null
cert_hash=$(openssl x509 -in "$cert" -pubkey -noout | openssl sha256)
key_hash=$(openssl pkey -in "$key" -pubout | openssl sha256)
[[ "$cert_hash" == "$key_hash" ]] || { echo 'Certificate and key mismatch' >&2; exit 1; }
[[ $(wc -l < "$pubkey") -le 1 ]] && grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "$pubkey"
ssh-keygen -lf "$pubkey" >/dev/null
[[ -s "$passwd" ]] && grep -Eq '^[^:]+:\$2[aby]\$' "$passwd"
getent group netpan >/dev/null || groupadd --system netpan
getent group netpan-release >/dev/null || groupadd --system netpan-release
useradd --system --gid netpan --home-dir /srv/netpandownload/data --shell /usr/sbin/nologin netpan
usermod -a -G netpan-release netpan
useradd --system --user-group --create-home --home-dir /var/lib/netpan-deploy --shell /bin/bash netpan-deploy
install -d -o netpan-deploy -g netpan-release -m 2750 /opt/netpandownload /opt/netpandownload/{releases,.staging,logs}
chown root:netpan /srv/netpandownload
chmod 0750 /srv/netpandownload
install -d -o netpan -g netpan -m 0700 /srv/netpandownload/{downloads,data}
install -d -o root -g netpan -m 0750 /etc/netpandownload
install -d -o netpan-deploy -g netpan-deploy -m 0700 /var/lib/netpan-deploy/.ssh
{ printf 'restrict '; cat "$pubkey"; printf '\n'; } > /var/lib/netpan-deploy/.ssh/authorized_keys
chown netpan-deploy:netpan-deploy /var/lib/netpan-deploy/.ssh/authorized_keys
chmod 0600 /var/lib/netpan-deploy/.ssh/authorized_keys
token=$(openssl rand -hex 32)
rpc_token=$(openssl rand -hex 32)
umask 077
cat > /etc/netpandownload/web.env <<EOF
NODE_ENV=production
PORT=3300
NETPAN_PRIVATE_WEB=true
NETPAN_PUBLIC_ORIGIN=https://$domain
NETPAN_WEB_TOKEN=$token
NETPAN_DOWNLOAD_DIR=/srv/netpandownload/downloads
NETPAN_DATA_DIR=/srv/netpandownload/data
NETPAN_MIN_FREE_BYTES=1073741824
ARIA2_ENABLED=true
ARIA2_RPC_URL=http://127.0.0.1:16801/jsonrpc
ARIA2_RPC_SECRET=$rpc_token
QUARK_MOCK=false
YTDLP_PATH=/usr/local/bin/yt-dlp
GALLERY_DL_PATH=/usr/local/bin/gallery-dl
EOF
cat > /etc/netpandownload/aria2.conf <<EOF
enable-rpc=true
rpc-listen-all=false
rpc-listen-port=16801
rpc-secret=$rpc_token
rpc-allow-origin-all=false
dir=/srv/netpandownload/downloads
input-file=/srv/netpandownload/data/aria2.session
save-session=/srv/netpandownload/data/aria2.session
save-session-interval=10
continue=true
auto-file-renaming=true
allow-overwrite=false
follow-torrent=false
follow-metalink=false
max-concurrent-downloads=2
max-connection-per-server=4
disk-cache=8M
file-allocation=none
max-download-result=500
force-save=true
EOF
chown root:netpan /etc/netpandownload/{web.env,aria2.conf}
chmod 0640 /etc/netpandownload/{web.env,aria2.conf}
install -o netpan -g netpan -m 0600 /dev/null /srv/netpandownload/data/aria2.session
install -o root -g www-data -m 0640 "$passwd" /etc/nginx/netpandownload.htpasswd
# Nginx master reads the root-only token-bearing site before dropping privilege.
sed -e "s|@DOMAIN@|$domain|g" -e "s|@CERT@|$cert|g" -e "s|@KEY@|$key|g" -e "s|@TOKEN@|$token|g" "$script_dir/nginx-netpan.conf.in" > /etc/nginx/sites-available/netpandownload.conf
chmod 0600 /etc/nginx/sites-available/netpandownload.conf
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$script_dir/netpan-start" /usr/local/libexec/netpan-start
install -o root -g root -m 0755 "$script_dir/netpan-health" /usr/local/libexec/netpan-health
install -o root -g root -m 0755 "$script_dir/netpan-release.py" /usr/local/libexec/netpan-release.py
install -o root -g root -m 0644 "$script_dir/systemd/"*.service /etc/systemd/system/
printf '%s\n' 'netpan-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart netpan-web.service, /usr/bin/systemctl stop netpan-web.service' > /etc/sudoers.d/netpan-deploy
printf '%s\n' 'netpan-deploy ALL=(netpan) NOPASSWD: /usr/local/libexec/netpan-health *' >> /etc/sudoers.d/netpan-deploy
chmod 0440 /etc/sudoers.d/netpan-deploy
visudo -cf /etc/sudoers.d/netpan-deploy
ln -s /etc/nginx/sites-available/netpandownload.conf /etc/nginx/sites-enabled/netpandownload.conf
if ! nginx -t; then
  unlink /etc/nginx/sites-enabled/netpandownload.conf
  echo 'NetPan site not enabled; existing Nginx process unchanged. Review initialization.' >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable --now netpan-aria2.service
systemctl enable netpan-web.service
systemctl reload nginx
echo 'NetPan initialized. Web service starts only after a verified release. Configure dedicated Environment Secrets.'
