#!/usr/bin/env python3
"""Temporarily expose an ACME webroot and request the NetPan certificate.

The production entry point intentionally has no path or environment overrides.  The
``TlsPreparer`` class accepts its dependencies so the safety and cleanup paths can be
tested without touching a live Nginx installation.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence, Tuple


DOMAIN_PATTERN = re.compile(
    r"^(?=.{1,253}$)"
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    re.IGNORECASE | re.ASCII,
)

CONFIG_NAME = "netpan-acme-bootstrap.conf"
ACME_ROOT = Path("/var/lib/netpandownload-acme")
SITES_AVAILABLE = Path("/etc/nginx/sites-available")
SITES_ENABLED = Path("/etc/nginx/sites-enabled")
LETSENCRYPT_LIVE = Path("/etc/letsencrypt/live")

MANAGED_MARKER = "# netpandownload temporary ACME bootstrap; do not edit\n"
CLEANUP_ERROR = (
    "TLS 临时配置清理未通过安全校验，请人工检查 Nginx 临时配置和链接；"
    "未删除不匹配的文件。"
)
DEPLOY_HOOK = "/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx"


class TlsSetupError(RuntimeError):
    """A safe, user-facing failure without command output or secret data."""


@dataclass(frozen=True)
class TlsPaths:
    """Filesystem locations used by one preparation run."""

    site_available: Path
    site_enabled: Path
    acme_root: Path
    cert_live_root: Path
    check_domain_script: Path

    @classmethod
    def production(cls) -> "TlsPaths":
        return cls(
            site_available=SITES_AVAILABLE / CONFIG_NAME,
            site_enabled=SITES_ENABLED / CONFIG_NAME,
            acme_root=ACME_ROOT,
            cert_live_root=LETSENCRYPT_LIVE,
            check_domain_script=Path(__file__).with_name("check-domain.py"),
        )


@dataclass(frozen=True)
class CertificatePaths:
    fullchain: Path
    private_key: Path


@dataclass(frozen=True)
class _CreatedConfig:
    path: Path
    device: int
    inode: int
    content: bytes
    digest: str


@dataclass(frozen=True)
class _CreatedLink:
    path: Path
    device: int
    inode: int
    target: str


@dataclass(frozen=True)
class _CreationRecord:
    config: Optional[_CreatedConfig]
    link: Optional[_CreatedLink]


def validate_domain(value: str) -> str:
    """Validate and normalize an ASCII DNS hostname used in Nginx and paths."""

    if not isinstance(value, str) or value != value.strip():
        raise TlsSetupError("DOMAIN 必须是无空格的 DNS 主机名。")
    if value.endswith(".") or not DOMAIN_PATTERN.fullmatch(value):
        raise TlsSetupError("DOMAIN 不是受支持的 DNS 主机名。")
    return value.lower()


def _lexists(path: Path) -> bool:
    """Path.exists() misses dangling symlinks, which must also be rejected."""

    return os.path.lexists(os.fspath(path))


def _stat_identity(path: Path) -> Tuple[int, int]:
    info = os.lstat(path)
    return info.st_dev, info.st_ino


def run_subprocess(
    command: Sequence[str], *, check: bool = True, capture_output: bool = True
) -> subprocess.CompletedProcess:
    """Run a command, capturing diagnostics unless interactive output is requested."""

    args = [str(item) for item in command]
    kwargs = {"check": check, "text": True}
    if capture_output:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return subprocess.run(args, **kwargs)


Runner = Callable[..., subprocess.CompletedProcess]
RootCheck = Callable[[], bool]
OwnerReader = Callable[[Path], int]


def _default_root_check() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid is not None and geteuid() == 0)


def _default_owner_reader(path: Path) -> int:
    return os.lstat(path).st_uid


class TlsPreparer:
    """Prepare one certificate request while preserving unrelated Nginx state."""

    def __init__(
        self,
        paths: Optional[TlsPaths] = None,
        *,
        runner: Runner = run_subprocess,
        root_check: RootCheck = _default_root_check,
        owner_reader: OwnerReader = _default_owner_reader,
    ) -> None:
        self.paths = paths or TlsPaths.production()
        self.runner = runner
        self.root_check = root_check
        self.owner_reader = owner_reader

    def prepare(self, domain_value: str) -> CertificatePaths:
        domain = validate_domain(domain_value)
        if not self.root_check():
            raise TlsSetupError("必须以 root 运行 TLS 初始化。")

        self._check_domain_occupancy(domain)
        self._reject_existing_targets()
        self._ensure_webroot()

        record = _CreationRecord(config=None, link=None)
        failure: Optional[BaseException] = None
        certificate: Optional[CertificatePaths] = None

        try:
            config = self._create_config(domain)
            record = _CreationRecord(config=config, link=None)
            link = self._create_link(config.path)
            record = _CreationRecord(config=config, link=link)

            self._run_checked(["nginx", "-t"], "Nginx 配置检查失败。")
            self._run_checked(["systemctl", "reload", "nginx"], "Nginx 重载失败。")

            certificate = self._request_certificate(domain)
        except BaseException as exc:  # cleanup must also run on Ctrl-C
            failure = exc
        finally:
            if record.config is not None or record.link is not None:
                cleanup_failure = self._cleanup(record)
                if cleanup_failure is not None:
                    failure = cleanup_failure

        if failure is not None:
            raise failure
        if certificate is None:
            raise TlsSetupError("TLS 初始化未生成证书。")
        return certificate

    def _check_domain_occupancy(self, domain: str) -> None:
        command = [sys.executable, str(self.paths.check_domain_script), domain]
        try:
            result = self.runner(command, check=True, capture_output=True)
        except Exception as exc:
            raise TlsSetupError("无法完成 Nginx 域名冲突检查。") from exc
        if getattr(result, "returncode", 0) != 0:
            raise TlsSetupError("请求的域名已被现有 Nginx 配置占用或检查失败。")

    def _reject_existing_targets(self) -> None:
        for target in (self.paths.site_available, self.paths.site_enabled):
            if _lexists(target):
                raise TlsSetupError(
                    "拒绝覆盖既有 TLS 临时配置目标：" + str(target)
                )
            if not target.parent.is_dir():
                raise TlsSetupError("Nginx 站点目录不存在：" + str(target.parent))

    def _ensure_webroot(self) -> None:
        root = self.paths.acme_root
        for directory in (root, root / ".well-known", root / ".well-known" / "acme-challenge"):
            self._ensure_webroot_directory(directory)

    def _ensure_webroot_directory(self, directory: Path) -> None:
        if _lexists(directory):
            info = os.lstat(directory)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise TlsSetupError("ACME webroot 路径必须逐级是安全的真实目录。")
            if self.owner_reader(directory) != 0:
                raise TlsSetupError("ACME webroot 路径必须逐级由 root 拥有。")
            if stat.S_IMODE(info.st_mode) != 0o755:
                raise TlsSetupError("ACME webroot 路径权限必须逐级严格为 0755。")
            return

        try:
            directory.mkdir(mode=0o755)
            os.chmod(directory, 0o755)
        except Exception as exc:
            raise TlsSetupError("无法创建 ACME webroot 路径。请人工检查目录状态。") from exc
        try:
            info = os.lstat(directory)
            owner = self.owner_reader(directory)
        except Exception as exc:
            raise TlsSetupError("无法验证新建的 ACME webroot 路径，请人工检查目录状态。") from exc
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISDIR(info.st_mode)
            or owner != 0
            or stat.S_IMODE(info.st_mode) != 0o755
        ):
            raise TlsSetupError("新建的 ACME webroot 路径未满足逐级 root/0755 安全要求。")

    @staticmethod
    def _config_content(domain: str, acme_root: Path) -> bytes:
        # The catch-all location prevents accidental exposure of any other URI.
        text = (
            MANAGED_MARKER
            + "server {\n"
            + "    listen 80;\n"
            + "    listen [::]:80;\n"
            + "    server_name "
            + domain
            + ";\n"
            + "\n"
            + "    location ^~ /.well-known/acme-challenge/ {\n"
            + "        root "
            + str(acme_root)
            + ";\n"
            + "        try_files $uri =404;\n"
            + "    }\n"
            + "\n"
            + "    location / {\n"
            + "        return 404;\n"
            + "    }\n"
            + "}\n"
        )
        return text.encode("utf-8")

    def _create_config(self, domain: str) -> _CreatedConfig:
        path = self.paths.site_available
        content = self._config_content(domain, self.paths.acme_root)
        fd: Optional[int] = None
        try:
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
            nofollow = getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags | nofollow, 0o644)
            with os.fdopen(fd, "wb") as handle:
                fd = None
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(path, 0o644)
            device, inode = _stat_identity(path)
        except FileExistsError as exc:
            raise TlsSetupError("拒绝覆盖既有 TLS 临时配置目标。") from exc
        except Exception as exc:
            if fd is not None:
                os.close(fd)
            raise TlsSetupError(
                "无法安全创建临时 Nginx ACME 配置；请人工检查是否遗留未启用的临时文件。"
            ) from exc
        return _CreatedConfig(
            path=path,
            device=device,
            inode=inode,
            content=content,
            digest=hashlib.sha256(content).hexdigest(),
        )

    def _create_link(self, config_path: Path) -> _CreatedLink:
        path = self.paths.site_enabled
        target = os.path.relpath(str(config_path), start=str(path.parent))
        try:
            os.symlink(target, path)
            device, inode = _stat_identity(path)
        except FileExistsError as exc:
            raise TlsSetupError("拒绝覆盖既有 TLS 临时配置链接。") from exc
        except Exception as exc:
            raise TlsSetupError("无法创建临时 Nginx ACME 配置链接。") from exc
        return _CreatedLink(path=path, device=device, inode=inode, target=target)

    def _run_checked(self, command: Sequence[str], message: str) -> None:
        try:
            result = self.runner(command, check=True, capture_output=True)
        except Exception as exc:
            raise TlsSetupError(message) from exc
        if getattr(result, "returncode", 0) != 0:
            raise TlsSetupError(message)

    def _request_certificate(self, domain: str) -> CertificatePaths:
        cert_name = "netpan-" + domain
        command = [
            "certbot",
            "certonly",
            "--webroot",
            "--webroot-path",
            str(self.paths.acme_root),
            "--domain",
            domain,
            "--cert-name",
            cert_name,
            "--deploy-hook",
            DEPLOY_HOOK,
        ]
        try:
            result = self.runner(command, check=False, capture_output=False)
        except Exception as exc:
            raise TlsSetupError("Certbot 执行失败。") from exc
        if getattr(result, "returncode", 0) != 0:
            raise TlsSetupError("Certbot 未签发证书。")

        cert_dir = self.paths.cert_live_root / cert_name
        fullchain = cert_dir / "fullchain.pem"
        private_key = cert_dir / "privkey.pem"
        for path in (fullchain, private_key):
            if not _lexists(path) or not path.is_file():
                raise TlsSetupError("Certbot 成功返回但证书文件不完整。")
        return CertificatePaths(fullchain=fullchain, private_key=private_key)

    @staticmethod
    def _config_state(record: _CreatedConfig) -> str:
        if not _lexists(record.path):
            return "missing"
        try:
            info = os.lstat(record.path)
            if not stat.S_ISREG(info.st_mode):
                return "changed"
            if (info.st_dev, info.st_ino) != (record.device, record.inode):
                return "changed"
            content = record.path.read_bytes()
            if hashlib.sha256(content).hexdigest() != record.digest:
                return "changed"
            if content != record.content:
                return "changed"
        except Exception:
            return "changed"
        return "exact"

    @staticmethod
    def _link_state(record: _CreatedLink) -> str:
        if not _lexists(record.path):
            return "missing"
        try:
            info = os.lstat(record.path)
            if not stat.S_ISLNK(info.st_mode):
                return "changed"
            if (info.st_dev, info.st_ino) != (record.device, record.inode):
                return "changed"
            if os.readlink(record.path) != record.target:
                return "changed"
        except Exception:
            return "changed"
        return "exact"

    @staticmethod
    def _unlink_if_present(path: Path) -> Optional[str]:
        try:
            if _lexists(path):
                os.unlink(path)
            return None
        except Exception:
            return str(path)

    def _cleanup(self, record: _CreationRecord) -> Optional[TlsSetupError]:
        config_state = self._config_state(record.config) if record.config else "missing"

        if record.link is not None:
            link_state = self._link_state(record.link)
        elif _lexists(self.paths.site_enabled):
            # A link appearing after our link creation failed is not ours.
            link_state = "changed"
        else:
            link_state = "missing"

        # Never run nginx against a site that changed after this process created it.
        # A fixed error also prevents a failed unlink from reloading unknown state.
        if config_state == "changed" or link_state == "changed":
            return TlsSetupError(CLEANUP_ERROR)

        if config_state == "exact" and link_state == "exact":
            error = self._unlink_if_present(record.link.path) if record.link else None
            if error:
                return TlsSetupError(CLEANUP_ERROR)
            error = self._unlink_if_present(record.config.path) if record.config else None
            if error:
                return TlsSetupError(CLEANUP_ERROR)
        elif config_state == "exact" and link_state == "missing":
            error = self._unlink_if_present(record.config.path) if record.config else None
            if error:
                return TlsSetupError(CLEANUP_ERROR)
        elif config_state == "missing" and link_state == "exact":
            # The config was removed externally; removing our still-identical link
            # cannot remove another site's file.
            error = self._unlink_if_present(record.link.path) if record.link else None
            if error:
                return TlsSetupError(CLEANUP_ERROR)

        if record.config is not None or record.link is not None:
            try:
                self._run_checked(["nginx", "-t"], "Nginx 清理后配置检查失败。")
                self._run_checked(
                    ["systemctl", "reload", "nginx"], "Nginx 清理后重载失败。"
                )
            except TlsSetupError:
                return TlsSetupError(CLEANUP_ERROR)
        return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("用法：python3 deploy/prepare-tls.py DOMAIN", file=sys.stderr)
        return 2
    try:
        result = TlsPreparer().prepare(args[0])
    except TlsSetupError as exc:
        print("TLS 初始化失败：" + str(exc), file=sys.stderr)
        return 1
    # Paths are useful to the next deployment step; no certificate or key content
    # is ever read or printed here.
    print("TLS 证书已准备：")
    print("fullchain：" + str(result.fullchain))
    print("private key：" + str(result.private_key))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
