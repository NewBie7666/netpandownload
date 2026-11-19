"""Validate the dedicated template with disposable TLS files; never install/reload it."""
from pathlib import Path
import subprocess
import shutil
import tempfile

source = Path(__file__).resolve().parents[1] / 'deploy/nginx-public-search.conf.in'
with tempfile.TemporaryDirectory(prefix='netpan-public-nginx-') as name:
    folder = Path(name)
    cert, key = folder / 'cert.pem', folder / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-subj', '/CN=search.example.com', '-days', '1',
                    '-out', str(cert), '-keyout', str(key)], check=True, capture_output=True)
    text = source.read_text(encoding='utf-8')
    text = text.replace('/etc/letsencrypt/live/search.example.com/fullchain.pem', str(cert))
    text = text.replace('/etc/letsencrypt/live/search.example.com/privkey.pem', str(key))
    text = text.replace('listen 80;', 'listen 18080;').replace('listen [::]:80;', 'listen [::]:18080;')
    text = text.replace('listen 443 ssl http2;', 'listen 18443 ssl http2;').replace('listen [::]:443 ssl http2;', 'listen [::]:18443 ssl http2;')
    config = folder / 'nginx.conf'
    config.write_text(f'error_log stderr;\npid {folder}/nginx.pid;\nevents {{}}\nhttp {{\n{text}\n}}\n', encoding='utf-8')
    subprocess.run(['nginx', '-t', '-c', str(config), '-p', str(folder)], check=True)
    # setup-node installs into the CI tool cache. Validate the otherwise exact
    # unit with that executable, without creating /usr/bin/node or installing a unit.
    unit_source = source.parent / 'systemd/netpan-public-search.service'
    unit = folder / 'netpan-public-search.service'
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required to validate the unit')
    unit.write_text(unit_source.read_text(encoding='utf-8').replace('ExecStart=/usr/bin/node ', f'ExecStart={node} '), encoding='utf-8')
    subprocess.run(['systemd-analyze', 'verify', str(unit)], check=True)
print('Dedicated public nginx template validated without installation or reload.')
