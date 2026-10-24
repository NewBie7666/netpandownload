"""Local Nginx syntax + real HTTPS Basic Auth + streaming proxy fixture, no root."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

token = 'a' * 64
class Backend(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.headers.get('X-Netpan-Token') == token
        assert not self.headers.get('Authorization')
        assert self.headers.get('Host') == '127.0.0.1:3300'
        body = b'netpan-private-proxy-stream'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

with tempfile.TemporaryDirectory(prefix='netpan-nginx-') as directory:
    root = Path(directory)
    upstream_port, tls_port = port(), port()
    backend = ThreadingHTTPServer(('127.0.0.1', upstream_port), Backend)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    subprocess.run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(root / 'key'), '-out', str(root / 'cert')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['htpasswd', '-bc', str(root / 'htpasswd'), 'fixture', 'fixture-password'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    site = Path(__file__).with_name('nginx-netpan.conf.in').read_text()
    replacements = {'@DOMAIN@': 'localhost', '@CERT@': str(root / 'cert'), '@KEY@': str(root / 'key'), '@TOKEN@': token, 'listen 443 ssl;': f'listen 127.0.0.1:{tls_port} ssl;', '/etc/nginx/netpandownload.htpasswd': str(root / 'htpasswd'), 'proxy_pass http://127.0.0.1:3300;': f'proxy_pass http://127.0.0.1:{upstream_port};'}
    for before, after in replacements.items():
        site = site.replace(before, after)
    config = root / 'nginx.conf'
    config.write_text(f'pid {root}/nginx.pid;\nerror_log {root}/error.log;\nevents {{}}\nhttp {{ access_log off; client_body_temp_path {root}/client; proxy_temp_path {root}/proxy; {site} }}\n')
    command = ['nginx', '-p', str(root) + '/', '-c', str(config)]
    subprocess.run(command + ['-t'], check=True, stdout=subprocess.DEVNULL)
    nginx = subprocess.Popen(command + ['-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    context = ssl.create_default_context(cafile=str(root / 'cert'))
    url = f'https://localhost:{tls_port}/api/downloads/file/0123456789abcdef'
    try:
        for attempt in range(40):
            try:
                urllib.request.urlopen(url, context=context, timeout=1)
            except urllib.error.HTTPError as e:
                assert e.code == 401
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise AssertionError('Nginx HTTPS never became ready')
        auth = 'Basic ' + base64.b64encode(b'fixture:fixture-password').decode()
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': auth, 'X-Netpan-Token': 'attacker-controlled'}), context=context, timeout=3) as resp:
            assert resp.status == 200
            assert resp.read() == b'netpan-private-proxy-stream'
        print('Nginx HTTPS authentication, token override, upstream credential stripping and stream verified')
    finally:
        nginx.terminate()
        nginx.wait(timeout=5)
        backend.shutdown()
        backend.server_close()
