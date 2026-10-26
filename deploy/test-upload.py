#!/usr/bin/env python3
"""Offline transport fixtures for deploy/upload-release.sh.

The fixture emulates only SSH/SCP and the protected smoke command.  It uses a
    real split/concatenate/hash path in the shell script and keeps all fake remote
    state in a temporary directory.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "deploy" / "upload-release.sh"
SHA = "a" * 40
SECRET = "fixture-secret-must-not-leak"


FAKE_SSH = r'''#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import sys

remote_root = Path(os.environ["FAKE_REMOTE_ROOT"])
call_log = Path(os.environ["FAKE_CALL_LOG"])
args = sys.argv[1:]
command = args[-1] if args else ""
with call_log.open("a", encoding="utf-8") as handle:
    handle.write("ssh " + command.replace("\n", "\\n") + "\n")

# Exercise the exact remote shell command while mapping its absolute paths to
# an isolated fixture root.  The real script validates the production path.
mapped = command.replace("/opt/netpandownload", str(remote_root))
mapped = mapped.replace("/usr/local/libexec/netpan-release.py", os.environ["FAKE_RELEASE_HELPER"])
result = subprocess.run(["bash", "-c", mapped], text=True, capture_output=True, env=os.environ.copy())
stdout = result.stdout.replace(str(remote_root), "/opt/netpandownload")
stderr = result.stderr
if stdout:
    sys.stdout.write(stdout)
if stderr:
    sys.stderr.write(stderr)
sys.exit(result.returncode)
'''


FAKE_SCP = r'''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

remote_root = Path(os.environ["FAKE_REMOTE_ROOT"])
call_log = Path(os.environ["FAKE_CALL_LOG"])
args = sys.argv[1:]
source = next((arg for arg in args if "chunk-" in arg and Path(arg).is_file()), None)
destination = args[-1] if args else ""
if not source or ":" not in destination:
    sys.exit(2)
name = Path(source).name
with call_log.open("a", encoding="utf-8") as handle:
    handle.write("scp " + name + "\n")
if os.environ.get("FAKE_SCP_FAIL") == name:
    sys.exit(7)
remote_path = destination.split(":", 1)[1]
prefix = "/opt/netpandownload"
if not remote_path.startswith(prefix + "/"):
    sys.exit(3)
target = remote_root / remote_path[len(prefix):].lstrip("/")
target.parent.mkdir(parents=True, exist_ok=True)
payload = Path(source).read_bytes()
if os.environ.get("FAKE_SCP_TAMPER") == name:
    payload = payload[:-1] + bytes([(payload[-1] ^ 0xFF) if payload else 0])
target.write_bytes(payload)
if os.environ.get("FAKE_RACE_DESTINATION") and name == "chunk-03":
    race = remote_root / ".staging" / ("netpan-" + os.environ["DEPLOY_SHA"] + ".tar.gz")
    if os.environ["FAKE_RACE_DESTINATION"] == "symlink":
        sentinel = remote_root / ".staging" / "race-sentinel"
        sentinel.write_bytes(b"race target")
        race.symlink_to(sentinel)
    else:
        race.write_bytes(b"race destination")
sys.exit(0)
'''


FAKE_MKTEMP = r'''#!/usr/bin/env python3
import os
import subprocess
import sys

args = sys.argv[1:]
if os.environ.get("FAKE_UNSAFE_PATH") and any(
    "/netpandownload" in arg or os.environ.get("FAKE_REMOTE_ROOT", "") in arg for arg in args
):
    print(os.environ["FAKE_UNSAFE_PATH"])
    raise SystemExit(0)
raise SystemExit(subprocess.run(["/usr/bin/mktemp", *args]).returncode)
'''


class UploadFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / ".release").mkdir()
        (self.root / "reports").mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.root / "runner").mkdir()
        self.remote = self.root / "remote"
        self.remote.mkdir()
        (self.remote / ".staging").mkdir()
        (self.remote / "logs").mkdir()
        self.call_log = self.root / "calls.log"
        self.deployed_marker = self.root / "deployed"
        self.release_helper = self.root / "release-helper"
        self._write_executable(
            self.release_helper,
            "#!/bin/sh\n"
            "printf 'release %s\\n' \"$1\" >> \"$FAKE_CALL_LOG\"\n"
            "if [ \"$1\" = deploy ]; then touch \"$FAKE_DEPLOYED\"; fi\n"
            "printf 'HEALTHY %s\\n' \"$FAKE_SHA\"\n",
        )
        self._write_executable(self.bin / "ssh", FAKE_SSH)
        self._write_executable(self.bin / "scp", FAKE_SCP)
        self._write_executable(self.bin / "mktemp", FAKE_MKTEMP)
        self._write_executable(self.bin / "node", "#!/bin/sh\nexit 0\n")
        archive = self.root / ".release" / f"netpan-{SHA}.tar.gz"
        archive.write_bytes((b"fixture release archive\n" * 70000) + b"tail\n")
        self.checksum = hashlib.sha256(archive.read_bytes()).hexdigest()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_executable(self, path: Path, content: str) -> None:
        path.write_text(textwrap.dedent(content))
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def run_upload(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "RUNNER_TEMP": str(self.root / "runner"),
                "GITHUB_STEP_SUMMARY": str(self.root / "summary"),
                "GITHUB_RUN_ID": "123456",
                "DEPLOY_HOST": "example.test",
                "DEPLOY_PORT": "22",
                "DEPLOY_USER": "netpan-deploy",
                "DEPLOY_SHA": SHA,
                "DEPLOY_CHECKSUM": self.checksum,
                "DEPLOY_KEY": SECRET,
                "DEPLOY_KNOWN_HOSTS": "example.test ssh-ed25519 AAAA",
                "NETPAN_TEST_BASE_URL": "https://download.example.test",
                "NETPAN_TEST_BASIC_USER": "admin",
                "NETPAN_TEST_BASIC_PASSWORD": SECRET,
                "FAKE_REMOTE_ROOT": str(self.remote),
                "FAKE_CALL_LOG": str(self.call_log),
                "FAKE_RELEASE_HELPER": str(self.release_helper),
                "FAKE_DEPLOYED": str(self.deployed_marker),
                "FAKE_SHA": SHA,
            }
        )
        env.update(overrides)
        return subprocess.run(
            ["bash", str(SCRIPT)], cwd=self.root, env=env,
            text=True, capture_output=True, timeout=30,
        )

    def calls(self) -> list[str]:
        return self.call_log.read_text().splitlines() if self.call_log.exists() else []

    def assert_temp_clean(self) -> None:
        self.assertEqual(list((self.root / "runner").iterdir()), [])
        self.assertEqual(
            [path for path in (self.remote / ".staging").iterdir() if path.name.startswith("netpan-upload-")],
            [],
        )

    def test_parallel_success_preserves_order_and_cleans_temp(self) -> None:
        result = self.run_upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.deployed_marker.exists())
        archive = self.root / ".release" / f"netpan-{SHA}.tar.gz"
        final = self.remote / ".staging" / f"netpan-{SHA}.tar.gz"
        self.assertEqual(final.read_bytes(), archive.read_bytes())
        for suffix in ("00", "01", "02", "03"):
            self.assertFalse((self.remote / f"chunk-{suffix}").exists())
        self.assertFalse((self.remote / "archive.tmp").exists())
        self.assert_temp_clean()
        self.assertNotIn(SECRET, "\n".join(path.read_text(errors="ignore") for path in (self.root / "reports").glob("**/*") if path.is_file()))

    def test_failed_chunk_does_not_deploy_and_cleans_remote(self) -> None:
        result = self.run_upload(FAKE_SCP_FAIL="chunk-02")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.deployed_marker.exists())
        self.assertFalse((self.remote / ".staging" / f"netpan-{SHA}.tar.gz").exists())
        self.assert_temp_clean()

    def test_tampered_chunk_fails_remote_checksum(self) -> None:
        result = self.run_upload(FAKE_SCP_TAMPER="chunk-01")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.deployed_marker.exists())
        self.assertFalse((self.remote / ".staging" / f"netpan-{SHA}.tar.gz").exists())
        self.assert_temp_clean()

    def test_unsafe_remote_temp_path_does_not_upload(self) -> None:
        result = self.run_upload(FAKE_UNSAFE_PATH="/tmp/unsafe")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(line.startswith("scp ") for line in self.calls()))
        self.assertFalse((self.remote / ".staging" / f"netpan-{SHA}.tar.gz").exists())
        self.assert_temp_clean()

    def test_preexisting_destination_is_untouched(self) -> None:
        existing = self.remote / ".staging" / f"netpan-{SHA}.tar.gz"
        existing.write_bytes(b"keep me")
        result = self.run_upload()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(existing.read_bytes(), b"keep me")
        self.assertFalse(any(line.startswith("scp ") for line in self.calls()))
        self.assert_temp_clean()

    def test_preexisting_destination_symlink_is_untouched(self) -> None:
        sentinel = self.remote / "sentinel"
        sentinel.write_bytes(b"keep link target")
        existing = self.remote / ".staging" / f"netpan-{SHA}.tar.gz"
        existing.symlink_to(sentinel)
        result = self.run_upload()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(existing.is_symlink())
        self.assertEqual(sentinel.read_bytes(), b"keep link target")
        self.assertFalse(any(line.startswith("scp ") for line in self.calls()))
        self.assert_temp_clean()

    def test_destination_created_during_upload_is_rejected(self) -> None:
        result = self.run_upload(FAKE_RACE_DESTINATION="file")
        self.assertNotEqual(result.returncode, 0)
        final = self.remote / ".staging" / f"netpan-{SHA}.tar.gz"
        self.assertEqual(final.read_bytes(), b"race destination")
        self.assertFalse(self.deployed_marker.exists())
        self.assert_temp_clean()

    def test_symlink_created_during_upload_is_rejected(self) -> None:
        result = self.run_upload(FAKE_RACE_DESTINATION="symlink")
        self.assertNotEqual(result.returncode, 0)
        final = self.remote / ".staging" / f"netpan-{SHA}.tar.gz"
        self.assertTrue(final.is_symlink())
        self.assertEqual(final.resolve().read_bytes(), b"race target")
        self.assertFalse(self.deployed_marker.exists())
        self.assert_temp_clean()


if __name__ == "__main__":
    unittest.main()
