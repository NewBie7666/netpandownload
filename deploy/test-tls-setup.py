#!/usr/bin/env python3
"""Unit tests for deploy/prepare-tls.py using isolated temporary paths."""

from __future__ import annotations

import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import List, Sequence


MODULE_PATH = Path(__file__).with_name("prepare-tls.py")
SPEC = importlib.util.spec_from_file_location("prepare_tls", MODULE_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import failure is fatal
    raise RuntimeError("Unable to load prepare-tls.py")
prepare_tls = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prepare_tls
SPEC.loader.exec_module(prepare_tls)


def symlink_supported(directory: Path) -> bool:
    target = directory / "target"
    link = directory / "link"
    try:
        target.write_text("x", encoding="utf-8")
        os.symlink(target, link)
        link.unlink()
        target.unlink()
        return True
    except (OSError, NotImplementedError):
        for path in (link, target):
            try:
                path.unlink()
            except OSError:
                pass
        return False


class FakeRunner:
    def __init__(self, paths, *, certbot_code: int = 0, mutate: bool = False):
        self.paths = paths
        self.certbot_code = certbot_code
        self.mutate = mutate
        self.calls: List[tuple] = []

    def __call__(self, command: Sequence[str], *, check=True, capture_output=True):
        args = [str(item) for item in command]
        self.calls.append((args, check, capture_output))
        if len(args) >= 2 and Path(args[1]).name == "check-domain.py":
            return SimpleNamespace(returncode=0)
        if args[:2] == ["nginx", "-t"]:
            return SimpleNamespace(returncode=0)
        if args[:3] == ["systemctl", "reload", "nginx"]:
            return SimpleNamespace(returncode=0)
        if args and args[0] == "certbot":
            if self.mutate:
                self.paths.site_available.write_text(
                    "# changed by another process\n", encoding="utf-8"
                )
                self.paths.site_enabled.unlink()
                os.symlink("../other.conf", self.paths.site_enabled)
            if self.certbot_code == 0:
                cert_dir = self.paths.cert_live_root / "netpan-download.example.com"
                cert_dir.mkdir(parents=True, exist_ok=True)
                (cert_dir / "fullchain.pem").write_text(
                    "certificate", encoding="utf-8"
                )
                (cert_dir / "privkey.pem").write_text(
                    "private-key", encoding="utf-8"
                )
            return SimpleNamespace(returncode=self.certbot_code)
        raise AssertionError("Unexpected command: " + " ".join(args))


class TlsSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.available = self.root / "sites-available"
        self.enabled = self.root / "sites-enabled"
        self.available.mkdir()
        self.enabled.mkdir()
        self.acme_parent = self.root / "var-lib"
        self.acme_parent.mkdir()
        self.cert_live = self.root / "letsencrypt" / "live"
        self.cert_live.mkdir(parents=True)
        self.checker = self.root / "check-domain.py"
        self.checker.write_text("# fake checker\n", encoding="utf-8")
        self.paths = prepare_tls.TlsPaths(
            site_available=self.available / prepare_tls.CONFIG_NAME,
            site_enabled=self.enabled / prepare_tls.CONFIG_NAME,
            acme_root=self.acme_parent / "netpandownload-acme",
            cert_live_root=self.cert_live,
            check_domain_script=self.checker,
        )

    def tearDown(self):
        self.temp.cleanup()

    def make_preparer(self, runner):
        return prepare_tls.TlsPreparer(
            self.paths,
            runner=runner,
            root_check=lambda: True,
            owner_reader=lambda path: 0,
        )

    def require_symlinks(self):
        if not symlink_supported(self.root):
            self.skipTest("symlink creation is unavailable on this platform")

    def test_invalid_domain_is_rejected_before_commands(self):
        runner = FakeRunner(self.paths)
        for value in ("", "https://download.example.com", "127.0.0.1", "download..example.com"):
            with self.subTest(value=value):
                with self.assertRaises(prepare_tls.TlsSetupError):
                    self.make_preparer(runner).prepare(value)
        self.assertEqual(runner.calls, [])

    def test_regular_existing_target_is_rejected_without_overwrite(self):
        self.paths.site_available.write_text("immune site\n", encoding="utf-8")
        before = self.paths.site_available.read_bytes()
        runner = FakeRunner(self.paths)
        with self.assertRaises(prepare_tls.TlsSetupError):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertEqual(self.paths.site_available.read_bytes(), before)
        self.assertEqual(len(runner.calls), 1)

    def test_existing_non_directory_webroot_is_rejected(self):
        self.paths.acme_root.write_text("not a directory\n", encoding="utf-8")
        runner = FakeRunner(self.paths)
        with self.assertRaisesRegex(prepare_tls.TlsSetupError, "webroot"):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertTrue(self.paths.acme_root.is_file())
        self.assertEqual(len(runner.calls), 1)

    def test_unsafe_child_webroot_is_rejected(self):
        self.paths.acme_root.mkdir()
        self.paths.acme_root.chmod(0o755)
        (self.paths.acme_root / ".well-known").write_text(
            "not a directory\n", encoding="utf-8"
        )
        runner = FakeRunner(self.paths)
        with self.assertRaisesRegex(prepare_tls.TlsSetupError, "逐级"):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertTrue((self.paths.acme_root / ".well-known").is_file())
        self.assertEqual(len(runner.calls), 1)

    def test_success_order_and_webroot_is_retained(self):
        self.require_symlinks()
        runner = FakeRunner(self.paths)
        result = self.make_preparer(runner).prepare("Download.Example.com")

        self.assertEqual(
            result.fullchain,
            self.cert_live / "netpan-download.example.com" / "fullchain.pem",
        )
        self.assertFalse(self.paths.site_available.exists())
        self.assertFalse(os.path.lexists(self.paths.site_enabled))
        self.assertTrue(self.paths.acme_root.is_dir())
        self.assertEqual(stat.S_IMODE(self.paths.acme_root.stat().st_mode), 0o755)
        names = [call[0][0] for call in runner.calls]
        self.assertEqual(
            names,
            [sys.executable, "nginx", "systemctl", "certbot", "nginx", "systemctl"],
        )
        certbot = next(call[0] for call in runner.calls if call[0][0] == "certbot")
        self.assertEqual(
            certbot,
            [
                "certbot",
                "certonly",
                "--webroot",
                "--webroot-path",
                str(self.paths.acme_root),
                "--domain",
                "download.example.com",
                "--cert-name",
                "netpan-download.example.com",
                "--deploy-hook",
                prepare_tls.DEPLOY_HOOK,
            ],
        )

    def test_certbot_failure_cleans_temporary_site(self):
        self.require_symlinks()
        runner = FakeRunner(self.paths, certbot_code=1)
        with self.assertRaises(prepare_tls.TlsSetupError):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertFalse(self.paths.site_available.exists())
        self.assertFalse(os.path.lexists(self.paths.site_enabled))
        self.assertTrue(self.paths.acme_root.is_dir())

    def test_existing_target_including_dangling_link_is_rejected(self):
        self.require_symlinks()
        os.symlink("missing.conf", self.paths.site_enabled)
        runner = FakeRunner(self.paths)
        with self.assertRaises(prepare_tls.TlsSetupError):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertTrue(os.path.lexists(self.paths.site_enabled))
        self.assertEqual(len(runner.calls), 1)  # only the quiet occupancy check

    def test_unsafe_existing_webroot_is_rejected(self):
        self.require_symlinks()
        other = self.root / "other"
        other.mkdir()
        os.symlink(other, self.paths.acme_root)
        runner = FakeRunner(self.paths)
        with self.assertRaises(prepare_tls.TlsSetupError):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertFalse(self.paths.site_available.exists())
        self.assertEqual(len(runner.calls), 1)

    def test_third_party_change_is_not_deleted(self):
        self.require_symlinks()
        runner = FakeRunner(self.paths, mutate=True)
        with self.assertRaisesRegex(prepare_tls.TlsSetupError, "清理"):
            self.make_preparer(runner).prepare("download.example.com")
        self.assertEqual(
            self.paths.site_available.read_text(encoding="utf-8"),
            "# changed by another process\n",
        )
        self.assertEqual(os.readlink(self.paths.site_enabled), "../other.conf")
        names = [call[0][0] for call in runner.calls]
        self.assertEqual(names, [sys.executable, "nginx", "systemctl", "certbot"])

    def test_immune_files_are_not_touched(self):
        self.require_symlinks()
        immune_available = self.available / "immune-arena.conf"
        immune_enabled = self.enabled / "immune-arena.conf"
        immune_available.write_text("server { listen 80; }\n", encoding="utf-8")
        os.symlink("../sites-available/immune-arena.conf", immune_enabled)
        before = immune_available.read_bytes()
        before_link = os.readlink(immune_enabled)

        runner = FakeRunner(self.paths)
        self.make_preparer(runner).prepare("download.example.com")

        self.assertEqual(immune_available.read_bytes(), before)
        self.assertEqual(os.readlink(immune_enabled), before_link)


if __name__ == "__main__":
    unittest.main(verbosity=2)
