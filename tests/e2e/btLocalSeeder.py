"""Local-only, legally generated torrent fixture for Windows CI.

No public trackers are used by the fixture itself. This script writes a synthetic file,
seeds it using python-libtorrent, and supplies peers through a loopback HTTP tracker.
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import libtorrent as lt


def bencode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode("ascii") + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode("ascii") + b":" + value
    if isinstance(value, str):
        return bencode(value.encode("utf-8"))
    if isinstance(value, list):
        return b"l" + b"".join(bencode(v) for v in value) + b"e"
    if isinstance(value, dict):
        return b"d" + b"".join(bencode(k) + bencode(value[k])
                              for k in sorted(value.keys())) + b"e"
    raise TypeError(type(value))


def main(base: Path) -> None:
    base.mkdir(parents=True, exist_ok=True)
    source_dir = base / "source"
    source_dir.mkdir(exist_ok=True)
    filename = "netpan-local-bt-test.bin"
    payload = (b"NetPanDownload BT end-to-end local test - " * 7000)[:262144]
    (source_dir / filename).write_bytes(payload)

    piece_size = 16384
    pieces = b"".join(hashlib.sha1(payload[i:i + piece_size]).digest()
                      for i in range(0, len(payload), piece_size))
    info = {
        "length": len(payload),
        "name": filename,
        "piece length": piece_size,
        "pieces": pieces
    }
    # BT clients may deliberately filter localhost peers as self-connections.
    # Use the host's real private IPv4 for the loopback-on-the-same-machine fixture.
    possible_ips = [entry[4][0] for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    host_ip = next((ip for ip in possible_ips if not ip.startswith("127.")), "127.0.0.1")
    tracker_uri = "http://" + host_ip + ":18999/announce"
    metadata = {"announce": tracker_uri, "info": info}
    torrent_file = base / "local-test.torrent"
    torrent_file.write_bytes(bencode(metadata))
    info_hash = hashlib.sha1(bencode(info)).hexdigest()

    session = lt.session({
        "listen_interfaces": "0.0.0.0:25252",
        "enable_dht": False,
        "enable_lsd": False,
        "enable_upnp": False,
        "enable_natpmp": False
    })
    info_file = lt.torrent_info(str(torrent_file))
    params = lt.add_torrent_params()
    params.ti = info_file
    params.save_path = str(source_dir)
    handle = session.add_torrent(params)
    for _ in range(100):
        if handle.status().is_seeding:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Local BT seeder did not finish hashing test fixture")

    class Tracker(BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.startswith("/announce?"):
                self.send_error(404)
                return
            print('TRACKER announce received', flush=True)
            peers = socket.inet_aton(host_ip) + struct.pack(">H", 25252)
            response = b"d8:intervali30e5:peers6:" + peers + b"e"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("0.0.0.0", 18999), Tracker)
    magnet = "magnet:?" + urlencode({
        "xt": "urn:btih:" + info_hash,
        "dn": filename,
        "tr": tracker_uri
    })
    # Content is synthetic; this URL is not a user's magnet.
    (base / "fixture.json").write_text(json.dumps({
        "magnet": magnet,
        "filename": filename,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "infoHash": info_hash,
        "size": len(payload)
    }), encoding="utf-8")

    print("Local BT fixture seeded on " + host_ip + ":25252", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
