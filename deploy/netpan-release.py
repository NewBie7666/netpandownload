#!/usr/bin/python3
"""Runs as netpan-deploy, never root. No extraction hooks or package installs."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = Path('/opt/netpandownload')
SHA = re.compile(r'[0-9a-f]{40}')

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(file):
    with file.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def safe_dir(p):
    require(p.is_dir() and not p.is_symlink() and p.resolve() == p, f'unsafe directory: {p}')

def verify(release, sha):
    safe_dir(release)
    manifest = release / 'SHA256SUMS'
    require(manifest.is_file() and not manifest.is_symlink(), 'missing checksums')
    listed = set()
    for line in manifest.read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([^\r\n]+)', line)
        require(match, 'malformed checksum line')
        checksum, name = match.groups()
        parts = PurePosixPath(name).parts
        require(parts and '..' not in parts and not name.startswith('/') and '\\' not in name and name == PurePosixPath(name).as_posix(), 'unsafe checksum path')
        require(name not in listed and name != 'SHA256SUMS', 'duplicate checksum')
        listed.add(name)
        f = release / name
        require(f.is_file() and not f.is_symlink() and f.resolve().is_relative_to(release), 'invalid manifest file')
        require(digest(f) == checksum, f'checksum failed: {name}')
    actual = set()
    for f in release.rglob('*'):
        require(not f.is_symlink(), 'release symlink rejected')
        require(f.is_file() or f.is_dir(), 'special release file rejected')
        if f.is_file() and f != manifest:
            actual.add(f.relative_to(release).as_posix())
    require(actual == listed, 'manifest does not cover exact release contents')
    for name in ('dist/index.html', 'dist-server/server/index.js', 'node_modules/express/package.json', 'version.json', 'package-lock.json'):
        require(name in listed, f'missing required file: {name}')
    version = json.loads((release / 'version.json').read_text())
    require(version.get('sha') == sha and version.get('platform') == 'linux' and version.get('arch') == 'x64' and version.get('node') == '22.23.4', 'release identity mismatch')
    return version

def unpack(archive, target, sha, checksum):
    require(archive.is_file() and not archive.is_symlink() and archive.parent.resolve() == ROOT / '.staging', 'archive must be in dedicated staging')
    require(digest(archive) == checksum, 'archive checksum mismatch')
    require(not target.exists() and not target.is_symlink(), 'release already exists')
    with tarfile.open(archive, 'r:gz') as tf:
        members = tf.getmembers()
        require(0 < len(members) < 100000 and sum(m.size for m in members) < 2 * 1024**3, 'archive exceeds limits')
        seen = set()
        for m in members:
            name = PurePosixPath(m.name)
            require(m.isfile() and not m.name.startswith('/') and '..' not in name.parts and '\\' not in m.name and m.name == name.as_posix() and m.name not in seen, 'unsafe archive entry')
            seen.add(m.name)
        require(shutil.disk_usage(ROOT).free > sum(m.size for m in members) + 512 * 1024**2, 'insufficient release disk space')
        target.mkdir(mode=0o750)
        for m in members:
            dest = target / m.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tf.extractfile(m) as source, dest.open('xb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            dest.chmod(0o755 if m.mode & 0o111 else 0o644)
    verify(target, sha)

def current_sha(name='current'):
    link = ROOT / name
    if not link.exists() and not link.is_symlink():
        return None
    require(link.is_symlink(), f'{name} is not a symlink')
    target = link.resolve(strict=True)
    require(target.parent == ROOT / 'releases' and SHA.fullmatch(target.name), f'invalid {name} target')
    safe_dir(target)
    return target.name

def switch(sha, name='current'):
    link = ROOT / f'.{name}-{os.getpid()}'
    require(not link.exists() and not link.is_symlink(), 'temporary switch exists')
    link.symlink_to(f'releases/{sha}')
    link.replace(ROOT / name)

def service(action):
    subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/systemctl', action, 'netpan-web.service'], check=True, timeout=60, stdout=subprocess.DEVNULL)

def health(sha):
    subprocess.run(['/usr/bin/sudo', '-n', '-u', 'netpan', '/usr/local/libexec/netpan-health', sha], check=True, timeout=150)

def prune(preserve_archive=None):
    """Bounded retention only inside this application's validated directories."""
    protected = {current_sha(), current_sha('previous')}
    releases = sorted((p for p in (ROOT / 'releases').iterdir() if SHA.fullmatch(p.name)), key=lambda p: p.lstat().st_mtime, reverse=True)
    for release in releases[5:]:
        if release.name in protected:
            continue
        safe_dir(release)
        require(release.parent == ROOT / 'releases', 'retention path escaped')
        require(all(not p.is_symlink() for p in release.rglob('*')), 'retention refuses symlinks')
        shutil.rmtree(release)
    for directory, pattern, count in [('.staging', r'netpan-[0-9a-f]{40}\.tar\.gz', 3), ('logs', r'[0-9a-f]{40}-[0-9]+\.log', 30)]:
        items = sorted((p for p in (ROOT / directory).iterdir() if re.fullmatch(pattern, p.name) and p != preserve_archive), key=lambda p: p.lstat().st_mtime, reverse=True)
        for item in items[count:]:
            require(item.is_file() and not item.is_symlink() and item.resolve().parent == ROOT / directory, 'unsafe retention file')
            item.unlink()

def deploy(archive, sha, checksum):
    prune(archive)
    previous = current_sha()
    if previous:
        verify(ROOT / 'releases' / previous, previous)
    target = ROOT / 'releases' / sha
    unpack(archive, target, sha, checksum)
    switch(sha)
    try:
        service('restart')
        health(sha)
    except Exception:
        if previous:
            switch(previous)
            service('restart')
            health(previous)
            print(f'ROLLBACK restored {previous}', flush=True)
        else:
            (ROOT / 'current').unlink()
            service('stop')
            print('ROLLBACK first release stopped; no previous release', flush=True)
        raise
    if previous:
        switch(previous, 'previous')
    try:
        archive.unlink()
        prune()
    except Exception:
        print('Retention cleanup needs administrator review; healthy release kept', file=sys.stderr)
    print(f'HEALTHY {sha}', flush=True)

def rollback():
    old, previous = current_sha(), current_sha('previous')
    require(old and previous and old != previous, 'rollback requires two distinct releases')
    verify(ROOT / 'releases' / previous, previous)
    switch(previous)
    try:
        service('restart')
        health(previous)
    except Exception:
        switch(old)
        service('restart')
        health(old)
        raise
    switch(old, 'previous')
    print(f'ROLLBACK {old} -> {previous}', flush=True)

def undo(sha):
    """Undo only the release selected by this CI run after public smoke failure."""
    require(current_sha() == sha, 'refusing to undo a different current release')
    if current_sha('previous'):
        rollback()
    else:
        (ROOT / 'current').unlink()
        service('stop')
        print(f'ROLLBACK stopped first release {sha}', flush=True)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['deploy', 'rollback', 'undo', 'verify-current'])
    p.add_argument('--sha')
    p.add_argument('--archive')
    p.add_argument('--checksum')
    a = p.parse_args()
    require(os.geteuid() != 0, 'release helper must never run as root')
    for directory in (ROOT, ROOT / '.staging', ROOT / 'releases', ROOT / 'logs'):
        safe_dir(directory)
    lock = ROOT / '.deploy.lock'
    require(not lock.is_symlink(), 'unsafe lock')
    with lock.open('a') as fd:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if a.action == 'deploy':
            require(a.sha and SHA.fullmatch(a.sha) and a.checksum and re.fullmatch('[0-9a-f]{64}', a.checksum) and a.archive, 'full SHA/archive checksum required')
            deploy(Path(a.archive), a.sha, a.checksum)
        elif a.action == 'rollback':
            rollback()
        elif a.action == 'undo':
            require(a.sha and SHA.fullmatch(a.sha), 'full SHA required for undo')
            undo(a.sha)
        else:
            sha = current_sha()
            require(sha, 'no current release')
            verify(ROOT / 'releases' / sha, sha)
            health(sha)
            print(f'HEALTHY {sha}')

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'netpan-release: {e}', file=sys.stderr)
        sys.exit(1)
