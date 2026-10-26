#!/usr/bin/env python3
"""Unit tests for deploy/prepare-storage.py.

All command execution and allocation are stubbed.  The tests therefore operate
only in a temporary directory and never create a real loop device or filesystem.
"""

from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace
from typing import List, Optional, Sequence


MODULE_PATH = Path(__file__).with_name("prepare-storage.py")
SPEC = importlib.util.spec_from_file_location("prepare_storage", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load prepare-storage.py")
prepare_storage = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prepare_storage
SPEC.loader.exec_module(prepare_storage)


class FakeRunner:
    def __init__(self, paths: prepare_storage.StoragePaths):
        self.paths = paths
        self.calls: List[List[str]] = []
        self.mounted_code = 32
        self.findmnt_stdout = "/dev/loop7 ext4 rw,nodev,nosuid,noexec\n"
        self.losetup_stdout = f"/dev/loop7 {paths.image}\n"
        self.mutate_fstab_on_losetup = False

    def __call__(self, command: Sequence[str], *, check=True, capture_output=True):
        args = [str(item) for item in command]
        self.calls.append(args)
        if args[:2] == ["mountpoint", "-q"]:
            return SimpleNamespace(returncode=self.mounted_code, stdout="", stderr="")
        if args and args[0] == "findmnt":
            return SimpleNamespace(returncode=0, stdout=self.findmnt_stdout, stderr="")
        if args and args[0] == "losetup":
            if self.mutate_fstab_on_losetup:
                self.paths.fstab.write_bytes(self.paths.fstab.read_bytes() + b"# changed\n")
            return SimpleNamespace(returncode=0, stdout=self.losetup_stdout, stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class StorageSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        # Keep the stub allocation tiny on Windows/NTFS and in constrained CI.
        # The production module retains the real 1024**3 GiB constant.
        self._saved_gib = prepare_storage.GIB
        self._saved_headroom = prepare_storage.HEADROOM_GIB
        prepare_storage.GIB = 1
        prepare_storage.HEADROOM_GIB = 1
        self.var = self.root / "var" / "lib"
        self.srv = self.root / "srv"
        self.etc = self.root / "etc"
        self.var.mkdir(parents=True)
        self.srv.mkdir()
        self.etc.mkdir()
        self.image = self.var / "netpandownload-data.img"
        self.mountpoint = self.srv / "netpandownload"
        self.fstab = self.etc / "fstab"
        self.backup = self.etc / "fstab.netpan-before-storage"
        self.original_fstab = b"# system configuration\nUUID=abc / ext4 defaults 0 1\n"
        self.fstab.write_bytes(self.original_fstab)
        self.fstab.chmod(0o640)
        self.paths = prepare_storage.StoragePaths(
            image=self.image,
            mountpoint=self.mountpoint,
            fstab=self.fstab,
            backup=self.backup,
        )
        self.runner = FakeRunner(self.paths)

    def tearDown(self):
        prepare_storage.GIB = self._saved_gib
        prepare_storage.HEADROOM_GIB = self._saved_headroom
        self.temp.cleanup()

    def allocator(self, fd: int, offset: int, length: int) -> None:
        os.ftruncate(fd, length)

    def make_preparer(
        self, *, runner=None, allocator=None, free_space=None, owner_reader=None
    ):
        return prepare_storage.StoragePreparer(
            self.paths,
            runner=runner or self.runner,
            allocator=allocator or self.allocator,
            free_space=free_space or (lambda path: 100 * prepare_storage.GIB),
            root_check=lambda: True,
            owner_reader=owner_reader or (lambda path: 0),
            command_exists=lambda command: "/usr/bin/" + command,
        )

    def test_success_preserves_original_fstab_and_records_order(self):
        mountpoint = self.make_preparer().prepare(4)

        self.assertEqual(mountpoint, self.mountpoint)
        self.assertEqual(self.backup.read_bytes(), self.original_fstab)
        expected_line = (
            f"{self.image} {self.mountpoint} ext4 "
            "loop,nodev,nosuid,noexec,nofail 0 0\n"
        ).encode()
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab + expected_line)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.fstab.stat().st_mode), 0o640)
            self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o600)
        self.assertTrue(self.image.is_file())
        self.assertEqual(self.image.stat().st_size, 4 * prepare_storage.GIB)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.image.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.mountpoint.stat().st_mode), 0o750)
        self.assertEqual(
            [call[0] for call in self.runner.calls],
            ["mkfs.ext4", "mountpoint", "mount", "findmnt", "losetup"],
        )

    def test_existing_image_is_rejected_without_mkfs(self):
        self.image.write_bytes(b"existing")
        before = self.image.read_bytes()

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)

        self.assertEqual(self.image.read_bytes(), before)
        self.assertEqual(self.runner.calls, [])

    def test_existing_hardlink_image_is_rejected(self):
        other = self.var / "other.img"
        other.write_bytes(b"existing")
        os.link(other, self.image)

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)
        self.assertEqual(self.image.stat().st_nlink, 2)
        self.assertEqual(self.runner.calls, [])

    def test_nonempty_mountpoint_is_rejected(self):
        self.mountpoint.mkdir()
        (self.mountpoint / "do-not-touch").write_text("immune", encoding="utf-8")

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)

        self.assertFalse(self.image.exists())
        self.assertEqual((self.mountpoint / "do-not-touch").read_text(), "immune")

    def test_mounted_mountpoint_is_rejected(self):
        self.mountpoint.mkdir()
        self.runner.mounted_code = 0

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)

        self.assertFalse(self.image.exists())
        self.assertEqual(self.runner.calls, [["mountpoint", "-q", str(self.mountpoint)]])

    @unittest.skipIf(os.name == "nt", "mountpoint exit codes are Linux-specific")
    def test_real_linux_mountpoint_reports_unmounted_as_32(self):
        self.mountpoint.mkdir()
        result = subprocess.run(
            ["mountpoint", "-q", str(self.mountpoint)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 32)
        preparer = self.make_preparer(runner=prepare_storage.run_subprocess)
        preparer._reject_if_mounted()

    def test_insufficient_space_is_rejected_before_creation(self):
        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "空间"):
            self.make_preparer(
                free_space=lambda path: 4 * prepare_storage.GIB
            ).prepare(4)

        self.assertFalse(self.image.exists())
        self.assertFalse(self.mountpoint.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)

    def test_system_filesystem_headroom_is_checked_separately(self):
        def free_space(path: Path) -> int:
            if path == self.image.parent:
                return 5 * prepare_storage.GIB
            return 0

        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "fstab"):
            self.make_preparer(free_space=free_space).prepare(4)
        self.assertFalse(self.image.exists())

    def test_image_parent_must_be_root_owned(self):
        def owner_reader(path: Path) -> int:
            return 1 if path == self.image.parent else 0

        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "root"):
            self.make_preparer(owner_reader=owner_reader).prepare(4)
        self.assertFalse(self.image.exists())

    @unittest.skipIf(os.name == "nt", "POSIX directory permissions are Linux-specific")
    def test_image_parent_cannot_be_group_or_world_writable(self):
        self.image.parent.chmod(0o777)
        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "可写"):
            self.make_preparer().prepare(4)
        self.assertFalse(self.image.exists())

    @unittest.skipIf(os.name == "nt", "POSIX directory fsync errors are Linux-specific")
    def test_linux_directory_fsync_error_is_not_suppressed(self):
        with mock.patch.object(
            prepare_storage.os, "open", side_effect=OSError(5, "I/O error")
        ):
            with self.assertRaisesRegex(prepare_storage.StorageSetupError, "同步"):
                prepare_storage.StoragePreparer._fsync_directory(self.etc)

    @unittest.skipIf(os.name == "nt", "identity replacement requires POSIX rename semantics")
    def test_new_image_identity_swap_never_reaches_mkfs(self):
        def swap_allocator(fd: int, offset: int, length: int) -> None:
            os.ftruncate(fd, length)
            replacement = self.var / "replacement.img"
            replacement.write_bytes(b"replacement")
            replacement.chmod(0o600)
            os.replace(replacement, self.image)

        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "身份"):
            self.make_preparer(allocator=swap_allocator).prepare(4)
        self.assertFalse(any(call[0] == "mkfs.ext4" for call in self.runner.calls))

    def test_wrong_loop_mapping_never_writes_fstab(self):
        other = self.var / "other.img"
        other.write_bytes(b"other")
        self.runner.losetup_stdout = f"/dev/loop7 {other}\n"

        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "loop"):
            self.make_preparer().prepare(4)

        self.assertFalse(self.backup.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)

    def test_existing_fstab_entry_is_rejected(self):
        self.fstab.write_bytes(
            self.original_fstab + f"{self.image} {self.mountpoint} ext4 defaults 0 2\n".encode()
        )

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)
        self.assertFalse(self.image.exists())
        self.assertFalse(self.backup.exists())

    def test_existing_backup_is_rejected_without_overwrite(self):
        self.backup.write_bytes(b"do not overwrite")
        before = self.backup.read_bytes()

        with self.assertRaises(prepare_storage.StorageSetupError):
            self.make_preparer().prepare(4)
        self.assertEqual(self.backup.read_bytes(), before)
        self.assertFalse(self.image.exists())

    def test_fstab_concurrent_change_is_not_overwritten(self):
        self.runner.mutate_fstab_on_losetup = True

        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "并发"):
            self.make_preparer().prepare(4)

        self.assertFalse(self.backup.exists())
        self.assertEqual(
            self.fstab.read_bytes(), self.original_fstab + b"# changed\n"
        )

    def test_immune_file_is_untouched(self):
        immune = self.root / "immune-arena-state"
        immune.write_bytes(b"must survive")
        self.make_preparer().prepare(4)
        self.assertEqual(immune.read_bytes(), b"must survive")

    def test_size_bounds_and_root_check(self):
        preparer = self.make_preparer()
        for size in (3, 1001):
            with self.subTest(size=size):
                with self.assertRaises(prepare_storage.StorageSetupError):
                    preparer.prepare(size)
        not_root = prepare_storage.StoragePreparer(
            self.paths,
            root_check=lambda: False,
            command_exists=lambda command: "/usr/bin/" + command,
        )
        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "root"):
            not_root.prepare(4)

    def test_missing_required_command_is_rejected(self):
        preparer = self.make_preparer()
        preparer.command_exists = lambda command: None if command == "losetup" else "/bin/" + command
        with self.assertRaisesRegex(prepare_storage.StorageSetupError, "命令"):
            preparer.prepare(4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
