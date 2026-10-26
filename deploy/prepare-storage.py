#!/usr/bin/env python3
"""Prepare the dedicated NetPan download filesystem.

The production command deliberately exposes only ``--size-gib``.  ``StoragePaths``
and all of the side-effecting dependencies are injectable so the safety checks can
be exercised in an unprivileged temporary directory without touching ``/etc/fstab``
or a real block device.
"""

from __future__ import annotations

import argparse
import errno
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence, Tuple


GIB = 1024 ** 3
MIN_SIZE_GIB = 4
MAX_SIZE_GIB = 1000
HEADROOM_GIB = 10

IMAGE_PATH = Path("/var/lib/netpandownload-data.img")
MOUNTPOINT_PATH = Path("/srv/netpandownload")
FSTAB_PATH = Path("/etc/fstab")
FSTAB_BACKUP_PATH = Path("/etc/fstab.netpan-before-storage")

REQUIRED_COMMANDS = ("mkfs.ext4", "mount", "mountpoint", "findmnt", "losetup")
LOOP_SOURCE = re.compile(r"^/dev/loop[0-9]+$")


class StorageSetupError(RuntimeError):
    """A safe, user-facing failure without command output or fstab contents."""


@dataclass(frozen=True)
class StoragePaths:
    """Filesystem locations used by a storage preparation run."""

    image: Path = IMAGE_PATH
    mountpoint: Path = MOUNTPOINT_PATH
    fstab: Path = FSTAB_PATH
    backup: Path = FSTAB_BACKUP_PATH

    @classmethod
    def production(cls) -> "StoragePaths":
        return cls()


@dataclass(frozen=True)
class _ImageIdentity:
    device: int
    inode: int
    size: int
    mode: int
    nlink: int


@dataclass(frozen=True)
class _MountpointIdentity:
    device: int
    inode: int


@dataclass(frozen=True)
class _FstabSnapshot:
    device: int
    inode: int
    mode: int
    uid: int
    gid: int
    content: bytes


def run_subprocess(
    command: Sequence[str], *, check: bool = True, capture_output: bool = True
) -> subprocess.CompletedProcess:
    """Run a command while retaining diagnostics only in the child process."""

    args = [str(item) for item in command]
    kwargs = {"check": check, "text": True}
    if capture_output:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return subprocess.run(args, **kwargs)


Runner = Callable[..., subprocess.CompletedProcess]
RootCheck = Callable[[], bool]
OwnerReader = Callable[[Path], int]
Allocator = Callable[[int, int, int], None]
FreeSpace = Callable[[Path], int]
CommandExists = Callable[[str], Optional[str]]


def _default_root_check() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid is not None and geteuid() == 0)


def _default_owner_reader(path: Path) -> int:
    return os.lstat(path).st_uid


def _default_allocator(fd: int, offset: int, length: int) -> None:
    fallocate = getattr(os, "posix_fallocate", None)
    if fallocate is None:
        raise OSError("posix_fallocate is unavailable")
    fallocate(fd, offset, length)


def _default_free_space(path: Path) -> int:
    return int(shutil.disk_usage(path).free)


def _lexists(path: Path) -> bool:
    """Path.exists() misses dangling symlinks, which must be rejected too."""

    return os.path.lexists(os.fspath(path))


def _is_regular_nonsymlink(info: os.stat_result) -> bool:
    return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def _mode_matches(mode: int, expected: int) -> bool:
    # The production target is Debian/Linux, where these checks are strict.  The
    # Windows test harness exposes no POSIX file mode bits, so it cannot represent
    # 0600/0750 even after chmod; structural and ownership checks still apply there.
    return os.name == "nt" or stat.S_IMODE(mode) == expected


def _display_size(size_bytes: int) -> str:
    gib = size_bytes / GIB
    if gib.is_integer():
        return f"{int(gib)} GiB"
    return f"{gib:.2f} GiB"


class StoragePreparer:
    """Perform the one-time, append-only storage preparation safely."""

    def __init__(
        self,
        paths: Optional[StoragePaths] = None,
        *,
        runner: Runner = run_subprocess,
        allocator: Allocator = _default_allocator,
        free_space: FreeSpace = _default_free_space,
        root_check: RootCheck = _default_root_check,
        owner_reader: OwnerReader = _default_owner_reader,
        command_exists: CommandExists = shutil.which,
    ) -> None:
        self.paths = paths or StoragePaths.production()
        self.runner = runner
        self.allocator = allocator
        self.free_space = free_space
        self.root_check = root_check
        self.owner_reader = owner_reader
        self.command_exists = command_exists

    def prepare(self, size_gib: int = 10) -> Path:
        size_bytes = self._validate_size(size_gib)
        if not self.root_check():
            raise StorageSetupError("必须以 root 运行存储初始化。")

        self._require_commands()
        self._check_available_space(size_bytes)
        fstab = self._read_fstab_snapshot()
        self._reject_existing_image()
        mountpoint_identity = self._check_mountpoint()
        self._reject_existing_backup()

        image_identity = self._create_image(size_bytes)
        self._verify_image_identity(image_identity)
        self._run_checked(
            ["mkfs.ext4", "-F", "-L", "netpan-data", str(self.paths.image)],
            "ext4 文件系统创建失败。",
        )

        created_mountpoint = mountpoint_identity is None
        if created_mountpoint:
            self._create_mountpoint()
            mountpoint_identity = self._mountpoint_identity(require_root=True)
            self._verify_mountpoint_empty()
        else:
            self._verify_mountpoint_unchanged(mountpoint_identity)
        self._reject_if_mounted()

        self._run_checked(
            [
                "mount",
                "-o",
                "loop,nodev,nosuid,noexec",
                str(self.paths.image),
                str(self.paths.mountpoint),
            ],
            "数据镜像挂载失败。",
        )
        source = self._verify_mount()
        # The fstab backup and replacement are deliberately after mount and loop
        # verification.  A wrong loop mapping therefore cannot write fstab.
        self._ensure_fstab_unchanged(fstab)
        self._create_fstab_backup(fstab)
        self._append_fstab(fstab)

        return self.paths.mountpoint

    @staticmethod
    def _validate_size(size_gib: int) -> int:
        if isinstance(size_gib, bool) or not isinstance(size_gib, int):
            raise StorageSetupError("--size-gib 必须是整数。")
        if not MIN_SIZE_GIB <= size_gib <= MAX_SIZE_GIB:
            raise StorageSetupError(
                f"--size-gib 必须在 {MIN_SIZE_GIB} 到 {MAX_SIZE_GIB} GiB 之间。"
            )
        return size_gib * GIB

    def _require_commands(self) -> None:
        for command in REQUIRED_COMMANDS:
            try:
                available = self.command_exists(command)
            except Exception as exc:
                raise StorageSetupError("无法检查系统所需命令，请人工核查。") from exc
            if not available:
                raise StorageSetupError("缺少存储初始化所需系统命令，请人工安装后重试。")

    def _check_available_space(self, size_bytes: int) -> None:
        image_required = size_bytes + HEADROOM_GIB * GIB
        system_required = HEADROOM_GIB * GIB
        image_available = self._available_space(self.paths.image.parent)
        if image_available < image_required:
            raise StorageSetupError(
                "数据镜像所在文件系统可用空间不足，必须保留至少 10 GiB 系统余量。"
            )
        system_available = self._available_space(self.paths.fstab.parent)
        if system_available < system_required:
            raise StorageSetupError(
                "fstab 所在系统文件系统可用空间不足，必须保留至少 10 GiB 系统余量。"
            )

    def _available_space(self, path: Path) -> int:
        try:
            value = self.free_space(path)
        except TypeError:
            # A zero-argument provider is useful in small test harnesses while the
            # production provider always accepts a path.
            try:
                value = self.free_space()  # type: ignore[call-arg]
            except Exception as exc:
                raise StorageSetupError("无法检查文件系统可用空间，请人工核查。") from exc
        except Exception as exc:
            raise StorageSetupError("无法检查文件系统可用空间，请人工核查。") from exc
        try:
            return int(value.free) if hasattr(value, "free") else int(value)
        except Exception as exc:
            raise StorageSetupError("无法检查文件系统可用空间，请人工核查。") from exc

    def _check_parent_directory(self, path: Path, label: str) -> None:
        parent = path.parent
        try:
            info = os.lstat(parent)
        except OSError as exc:
            raise StorageSetupError(f"{label} 父目录不存在或不可访问。") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StorageSetupError(f"{label} 父目录必须是真实目录。")
        try:
            owner = self.owner_reader(parent)
        except Exception as exc:
            raise StorageSetupError(f"{label} 父目录所有者无法核验。") from exc
        if owner != 0:
            raise StorageSetupError(f"{label} 父目录必须由 root 拥有。")
        # Windows test filesystems do not expose POSIX permission bits.  The
        # production target is Linux, where group/world writable parents are unsafe
        # for the image and fstab TOCTOU checks.
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o022:
            raise StorageSetupError(f"{label} 父目录不能对 group/world 可写。")

    def _reject_existing_image(self) -> None:
        self._check_parent_directory(self.paths.image, "数据镜像")
        if _lexists(self.paths.image):
            raise StorageSetupError("拒绝覆盖既有数据镜像；包括链接、块设备或硬链接。")

    def _read_fstab_snapshot(self) -> _FstabSnapshot:
        path = self.paths.fstab
        self._check_parent_directory(path, "fstab")
        try:
            info = os.lstat(path)
        except OSError as exc:
            raise StorageSetupError("fstab 不存在或不可访问，请人工核查。") from exc
        if not _is_regular_nonsymlink(info):
            raise StorageSetupError("fstab 必须是 root 拥有的普通文件。")
        try:
            owner = self.owner_reader(path)
        except Exception as exc:
            raise StorageSetupError("无法核验 fstab 所有者，请人工核查。") from exc
        if owner != 0:
            raise StorageSetupError("fstab 必须由 root 拥有。")
        try:
            content = path.read_bytes()
        except OSError as exc:
            raise StorageSetupError("无法读取 fstab，请人工核查。") from exc

        image_text = os.fspath(self.paths.image)
        mountpoint_text = os.fspath(self.paths.mountpoint)
        image_field = os.path.normpath(image_text)
        mountpoint_field = os.path.normpath(mountpoint_text)
        for raw_line in content.splitlines():
            line = raw_line.split(b"#", 1)[0].decode("utf-8", "surrogateescape")
            fields = line.split()
            normalized_fields = {os.path.normpath(field) for field in fields}
            if image_field in normalized_fields or mountpoint_field in normalized_fields:
                raise StorageSetupError("fstab 已包含数据镜像或挂载点条目。")

        return _FstabSnapshot(
            device=info.st_dev,
            inode=info.st_ino,
            mode=stat.S_IMODE(info.st_mode),
            uid=info.st_uid,
            gid=info.st_gid,
            content=content,
        )

    def _reject_existing_backup(self) -> None:
        self._check_parent_directory(self.paths.backup, "fstab 备份")
        if _lexists(self.paths.backup):
            raise StorageSetupError("拒绝覆盖既有 fstab 备份。")

    def _check_mountpoint(self) -> Optional[_MountpointIdentity]:
        path = self.paths.mountpoint
        self._check_parent_directory(path, "挂载点")
        if not _lexists(path):
            return None
        try:
            info = os.lstat(path)
        except OSError as exc:
            raise StorageSetupError("无法核验挂载点，请人工核查。") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StorageSetupError("挂载点必须是真实目录，不能是链接。")
        self._reject_if_mounted()
        try:
            if any(path.iterdir()):
                raise StorageSetupError("既有挂载点必须是空目录。")
        except StorageSetupError:
            raise
        except OSError as exc:
            raise StorageSetupError("无法检查挂载点内容，请人工核查。") from exc
        return _MountpointIdentity(info.st_dev, info.st_ino)

    def _reject_if_mounted(self) -> None:
        try:
            result = self.runner(
                ["mountpoint", "-q", str(self.paths.mountpoint)],
                check=False,
                capture_output=True,
            )
        except Exception as exc:
            raise StorageSetupError("无法核验挂载点状态，请人工核查。") from exc
        code = int(getattr(result, "returncode", 1))
        if code == 0:
            raise StorageSetupError("挂载点当前已经挂载，拒绝继续。")
        if code != 32:
            raise StorageSetupError("挂载点状态检查失败，请人工核查。")

    def _mountpoint_identity(self, *, require_root: bool = False) -> _MountpointIdentity:
        try:
            info = os.lstat(self.paths.mountpoint)
        except OSError as exc:
            raise StorageSetupError("无法核验新建挂载点，请人工核查。") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StorageSetupError("新建挂载点不是安全的真实目录。")
        if require_root:
            try:
                owner = self.owner_reader(self.paths.mountpoint)
            except Exception as exc:
                raise StorageSetupError("无法核验新建挂载点所有者，请人工核查。") from exc
            if owner != 0:
                raise StorageSetupError("新建挂载点必须由 root 拥有。")
        if require_root and not _mode_matches(info.st_mode, 0o750):
            raise StorageSetupError("新建挂载点权限必须为 0750。")
        return _MountpointIdentity(info.st_dev, info.st_ino)

    def _create_mountpoint(self) -> None:
        path = self.paths.mountpoint
        try:
            path.mkdir(mode=0o750)
            os.chmod(path, 0o750)
        except FileExistsError as exc:
            raise StorageSetupError("挂载点在检查后发生变化，请人工核查。") from exc
        except OSError as exc:
            raise StorageSetupError("无法创建挂载点，请人工核查。") from exc
        self._mountpoint_identity(require_root=True)

    def _verify_mountpoint_unchanged(self, identity: _MountpointIdentity) -> None:
        current = self._mountpoint_identity()
        if current != identity:
            raise StorageSetupError("挂载点在检查后发生变化，请人工核查。")
        self._verify_mountpoint_empty()

    def _verify_mountpoint_empty(self) -> None:
        try:
            if any(self.paths.mountpoint.iterdir()):
                raise StorageSetupError("挂载点在检查后变为非空，请人工核查。")
        except StorageSetupError:
            raise
        except OSError as exc:
            raise StorageSetupError("无法重新检查挂载点，请人工核查。") from exc

    def _create_image(self, size_bytes: int) -> _ImageIdentity:
        self._reject_existing_image()
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd: Optional[int] = None
        opened_identity: Optional[Tuple[int, int]] = None
        try:
            fd = os.open(self.paths.image, flags, 0o600)
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)
            else:
                os.chmod(self.paths.image, 0o600)
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise StorageSetupError("新建数据镜像身份校验失败，拒绝格式化。")
            opened_identity = (opened.st_dev, opened.st_ino)
            self.allocator(fd, 0, size_bytes)
            os.fsync(fd)
        except FileExistsError as exc:
            raise StorageSetupError("数据镜像在创建前已存在，拒绝覆盖。") from exc
        except StorageSetupError:
            raise
        except Exception as exc:
            raise StorageSetupError("无法预分配数据镜像；请人工核查，镜像不会自动删除。") from exc
        finally:
            if fd is not None:
                os.close(fd)
        try:
            info = os.lstat(self.paths.image)
        except OSError as exc:
            raise StorageSetupError("新建数据镜像无法核验，请人工检查镜像状态。") from exc
        try:
            owner = self.owner_reader(self.paths.image)
        except Exception as exc:
            raise StorageSetupError("新建数据镜像所有者无法核验，拒绝格式化。") from exc
        if (
            opened_identity is None
            or (info.st_dev, info.st_ino) != opened_identity
            or not _is_regular_nonsymlink(info)
            or info.st_nlink != 1
            or info.st_size != size_bytes
            or not _mode_matches(info.st_mode, 0o600)
            or owner != 0
        ):
            raise StorageSetupError("新建数据镜像身份校验失败，拒绝格式化。")
        return _ImageIdentity(
            device=info.st_dev,
            inode=info.st_ino,
            size=info.st_size,
            mode=stat.S_IMODE(info.st_mode),
            nlink=info.st_nlink,
        )

    def _verify_image_identity(self, identity: _ImageIdentity) -> None:
        try:
            info = os.lstat(self.paths.image)
        except OSError as exc:
            raise StorageSetupError("数据镜像在格式化前发生变化，拒绝操作。") from exc
        current = _ImageIdentity(
            device=info.st_dev,
            inode=info.st_ino,
            size=info.st_size,
            mode=stat.S_IMODE(info.st_mode),
            nlink=info.st_nlink,
        )
        try:
            owner = self.owner_reader(self.paths.image)
        except Exception as exc:
            raise StorageSetupError("数据镜像所有者无法核验，拒绝格式化。") from exc
        if (
            not _is_regular_nonsymlink(info)
            or current != identity
            or owner != 0
        ):
            raise StorageSetupError("数据镜像在格式化前发生变化，拒绝操作。")

    def _run_checked(self, command: Sequence[str], message: str) -> None:
        try:
            result = self.runner(command, check=True, capture_output=True)
        except Exception as exc:
            raise StorageSetupError(message) from exc
        if int(getattr(result, "returncode", 0)) != 0:
            raise StorageSetupError(message)

    def _verify_mount(self) -> str:
        try:
            result = self.runner(
                [
                    "findmnt",
                    "--mountpoint",
                    str(self.paths.mountpoint),
                    "--noheadings",
                    "--output",
                    "SOURCE,FSTYPE,OPTIONS",
                ],
                check=True,
                capture_output=True,
            )
        except Exception as exc:
            raise StorageSetupError("挂载后 findmnt 校验失败，请人工核查。") from exc
        if int(getattr(result, "returncode", 0)) != 0:
            raise StorageSetupError("挂载后 findmnt 校验失败，请人工核查。")
        raw_output = getattr(result, "stdout", "") or ""
        output = (
            raw_output.decode("utf-8", "replace")
            if isinstance(raw_output, bytes)
            else str(raw_output)
        )
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if len(lines) != 1:
            raise StorageSetupError("挂载点状态不唯一，请人工核查。")
        fields = lines[0].split(None, 2)
        if len(fields) != 3:
            raise StorageSetupError("挂载点信息格式异常，请人工核查。")
        source, filesystem, options = fields
        if not LOOP_SOURCE.fullmatch(source) or filesystem.lower() != "ext4":
            raise StorageSetupError("挂载设备或文件系统类型不符合要求，请人工核查。")
        option_set = {item for item in options.split(",") if item}
        if not {"nodev", "nosuid", "noexec"}.issubset(option_set):
            raise StorageSetupError("挂载安全选项不完整，请人工核查。")

        try:
            loop_result = self.runner(
                [
                    "losetup",
                    "--list",
                    "--noheadings",
                    "--output",
                    "NAME,BACK-FILE",
                ],
                check=True,
                capture_output=True,
            )
        except Exception as exc:
            raise StorageSetupError("无法核验 loop 后端文件，请人工核查。") from exc
        if int(getattr(loop_result, "returncode", 0)) != 0:
            raise StorageSetupError("无法核验 loop 后端文件，请人工核查。")
        raw_loop_output = getattr(loop_result, "stdout", "") or ""
        loop_output = (
            raw_loop_output.decode("utf-8", "replace")
            if isinstance(raw_loop_output, bytes)
            else str(raw_loop_output)
        )
        image_name = os.path.abspath(os.fspath(self.paths.image))
        found = False
        for line in loop_output.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2:
                continue
            loop_name, back_file = fields
            if loop_name == source and os.path.abspath(back_file) == image_name:
                found = True
                break
        if not found:
            raise StorageSetupError("loop 后端文件与新建数据镜像不一致，请人工核查。")
        return source

    def _current_fstab_snapshot(self) -> _FstabSnapshot:
        path = self.paths.fstab
        try:
            info = os.lstat(path)
            content = path.read_bytes()
            owner = self.owner_reader(path)
        except Exception as exc:
            raise StorageSetupError("无法重新核验 fstab，请人工核查。") from exc
        if not _is_regular_nonsymlink(info) or owner != 0:
            raise StorageSetupError("fstab 在操作期间失去 root 普通文件属性。")
        return _FstabSnapshot(
            device=info.st_dev,
            inode=info.st_ino,
            mode=stat.S_IMODE(info.st_mode),
            uid=info.st_uid,
            gid=info.st_gid,
            content=content,
        )

    @staticmethod
    def _same_fstab(left: _FstabSnapshot, right: _FstabSnapshot) -> bool:
        return left == right

    def _ensure_fstab_unchanged(self, expected: _FstabSnapshot) -> None:
        current = self._current_fstab_snapshot()
        if not self._same_fstab(current, expected):
            raise StorageSetupError("fstab 在操作期间发生并发修改，未覆盖原文件。")

    def _create_fstab_backup(self, expected: _FstabSnapshot) -> None:
        self._ensure_fstab_unchanged(expected)
        self._reject_existing_backup()
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd: Optional[int] = None
        try:
            fd = os.open(self.paths.backup, flags, 0o600)
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)
            else:
                os.chmod(self.paths.backup, 0o600)
            with os.fdopen(fd, "wb") as handle:
                fd = None
                handle.write(expected.content)
                handle.flush()
                os.fsync(handle.fileno())
            self._fsync_directory(self.paths.backup.parent)
        except FileExistsError as exc:
            raise StorageSetupError("拒绝覆盖既有 fstab 备份。") from exc
        except Exception as exc:
            raise StorageSetupError("无法安全保存 fstab 备份，请人工核查。") from exc
        finally:
            if fd is not None:
                os.close(fd)
        try:
            info = os.lstat(self.paths.backup)
            owner = self.owner_reader(self.paths.backup)
        except Exception as exc:
            raise StorageSetupError("fstab 备份无法核验，请人工核查。") from exc
        if (
            not _is_regular_nonsymlink(info)
            or not _mode_matches(info.st_mode, 0o600)
            or owner != 0
            or self.paths.backup.read_bytes() != expected.content
        ):
            raise StorageSetupError("fstab 备份校验失败，请人工核查。")

    def _append_fstab(self, expected: _FstabSnapshot) -> None:
        self._ensure_fstab_unchanged(expected)
        line = (
            f"{self.paths.image} {self.paths.mountpoint} ext4 "
            "loop,nodev,nosuid,noexec,nofail 0 0\n"
        ).encode("utf-8")
        parent = self.paths.fstab.parent
        fd: Optional[int] = None
        temporary: Optional[Path] = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=".fstab.netpan-", dir=parent)
            temporary = Path(temp_name)
            if hasattr(os, "fchmod"):
                os.fchmod(fd, expected.mode)
            else:
                os.chmod(temporary, expected.mode)
            if hasattr(os, "fchown"):
                try:
                    os.fchown(fd, expected.uid, expected.gid)
                except OSError as exc:
                    raise StorageSetupError("无法保留 fstab 原所有者，请人工核查。") from exc
            content = expected.content
            if content and not content.endswith(b"\n"):
                content += b"\n"
            with os.fdopen(fd, "wb") as handle:
                fd = None
                handle.write(content + line)
                handle.flush()
                os.fsync(handle.fileno())

            # An immediate identity/content check detects a concurrent modification
            # observed before replacement; this helper does not claim to provide a
            # system-wide lock against a writer that races after the check.
            self._ensure_fstab_unchanged(expected)
            os.replace(temporary, self.paths.fstab)
            temporary = None
            self._fsync_directory(parent)
        except StorageSetupError:
            raise
        except Exception as exc:
            raise StorageSetupError("无法原子更新 fstab，请人工核查。") from exc
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            if temporary is not None:
                try:
                    temporary.unlink()
                except OSError:
                    pass
        try:
            info = os.lstat(self.paths.fstab)
            if not _is_regular_nonsymlink(info):
                raise StorageSetupError("原子更新后 fstab 不是普通文件，请人工核查。")
            if not _mode_matches(info.st_mode, expected.mode):
                raise StorageSetupError("原子更新后 fstab 权限发生变化，请人工核查。")
            if (
                self.owner_reader(self.paths.fstab) != 0
                or info.st_uid != expected.uid
                or info.st_gid != expected.gid
            ):
                raise StorageSetupError("原子更新后 fstab 所有者不是 root，请人工核查。")
        except StorageSetupError:
            raise
        except Exception as exc:
            raise StorageSetupError("原子更新后无法核验 fstab，请人工核查。") from exc

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        directory_fd: Optional[int] = None
        try:
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            directory_fd = os.open(directory, flags)
            os.fsync(directory_fd)
        except OSError as exc:
            # Linux production must surface directory durability failures.  The
            # Windows-only test harness has no portable directory fsync operation.
            if os.name != "nt":
                raise StorageSetupError("无法同步 fstab 所在目录，请人工核查。") from exc
            return
        finally:
            if directory_fd is not None:
                try:
                    os.close(directory_fd)
                except OSError as exc:
                    if os.name != "nt":
                        raise StorageSetupError("无法关闭 fstab 所在目录，请人工核查。") from exc


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare the dedicated NetPan download filesystem."
    )
    parser.add_argument(
        "--size-gib",
        type=int,
        default=10,
        help=f"image size in GiB ({MIN_SIZE_GIB}-{MAX_SIZE_GIB}, default: 10)",
    )
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    try:
        mountpoint = StoragePreparer().prepare(args.size_gib)
    except StorageSetupError as exc:
        print(
            "存储初始化失败："
            + str(exc)
            + "；请人工核查，数据镜像不会自动删除，也不会卸载未知挂载。",
            file=sys.stderr,
        )
        return 1
    print("存储已准备：")
    print("挂载位置：" + str(mountpoint))
    print("容量：" + _display_size(args.size_gib * GIB))
    print("fstab 备份：" + str(StoragePaths.production().backup))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
