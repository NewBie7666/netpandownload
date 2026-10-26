"""Root-only acceptance with a fresh 32 MiB image and a temporary fstab.

Never reads or writes the host fstab. Never formats an existing file/device.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


if not hasattr(os, 'geteuid') or os.geteuid() != 0:
    raise SystemExit('Run this isolated loop acceptance as root')

spec = importlib.util.spec_from_file_location('storage_loop_fixture', Path(__file__).with_name('prepare-storage.py'))
storage = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = storage
spec.loader.exec_module(storage)
# The internal fixture uses MiB units. The production CLI always retains GiB.
storage.GIB = 1024 * 1024
root = Path(tempfile.mkdtemp(prefix='netpan-loop-acceptance-', dir='/tmp'))
assert root.parent == Path('/tmp') and root.name.startswith('netpan-loop-acceptance-')
paths = storage.StoragePaths(image=root / 'data.img', mountpoint=root / 'mounted', fstab=root / 'fstab', backup=root / 'fstab.backup')
original = b'# unrelated fixture configuration stays unchanged\n'
paths.fstab.write_bytes(original)
paths.fstab.chmod(0o644)
preparer = storage.StoragePreparer(paths)
safe_to_remove = False
try:
    preparer.prepare(32)
    source = preparer._verify_mount()
    size = os.statvfs(paths.mountpoint)
    assert 0 < size.f_blocks * size.f_frsize <= 32 * storage.GIB
    payload = paths.mountpoint / 'fixture-data'
    payload.write_bytes(b'netpan-loop-real-write')
    assert payload.read_bytes() == b'netpan-loop-real-write'
    assert paths.backup.read_bytes() == original
    assert paths.fstab.read_bytes().startswith(original)
    assert b'loop,nodev,nosuid,noexec,nofail 0 0\n' in paths.fstab.read_bytes()
    print('Real ext4 loop mount, bounded capacity, read/write, flags and isolated fstab verified')
finally:
    if paths.mountpoint.exists():
        status = subprocess.run(['mountpoint', '-q', str(paths.mountpoint)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        if status == 0:
            # Only detach the mount whose backing file was just verified as ours.
            preparer._verify_mount()
            subprocess.run(['umount', str(paths.mountpoint)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            status = subprocess.run(['mountpoint', '-q', str(paths.mountpoint)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        safe_to_remove = status == 32
    else:
        safe_to_remove = True
    if safe_to_remove:
        assert root.parent == Path('/tmp') and not root.is_symlink()
        shutil.rmtree(root)
    else:
        print('Fixture mount still present; temporary state retained for inspection', file=sys.stderr)
