#!/usr/bin/env python3
"""Build a Linux-only, secret-free release from the exact tested checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile

p = argparse.ArgumentParser()
p.add_argument('--sha', required=True)
p.add_argument('--output', default='.release')
a = p.parse_args()
assert re.fullmatch('[0-9a-f]{40}', a.sha), 'full source SHA required'
assert platform.system() == 'Linux' and platform.machine() == 'x86_64', 'build on Linux x86_64'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == a.sha
assert subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.23.4'
out = Path(a.output).resolve()
out.mkdir(parents=True, exist_ok=True)
stage = out / a.sha
stage.mkdir(exist_ok=False)
for name in ('dist', 'dist-server', 'node_modules'):
    assert Path(name).is_dir(), f'missing {name}'
    shutil.copytree(name, stage / name, symlinks=True)
for name in ('package.json', 'package-lock.json'):
    shutil.copyfile(name, stage / name)
for item in list(stage.rglob('*')):
    if item.is_symlink():
        item.unlink()  # npm .bin symlinks are not needed to run compiled Express.
(stage / 'version.json').write_text(json.dumps({
    'sha': a.sha, 'platform': 'linux', 'arch': 'x64', 'node': '22.23.4',
    'runId': os.environ.get('GITHUB_RUN_ID'),
}) + '\n')
files = sorted(f for f in stage.rglob('*') if f.is_file())
with (stage / 'SHA256SUMS').open('w', newline='\n') as sums:
    for f in files:
        sums.write(f'{hashlib.file_digest(f.open("rb"), "sha256").hexdigest()}  {f.relative_to(stage).as_posix()}\n')
archive = out / f'netpan-{a.sha}.tar.gz'
with tarfile.open(archive, 'w:gz', dereference=False) as tf:
    for f in sorted(stage.rglob('*')):
        if f.is_file():
            tf.add(f, arcname=f.relative_to(stage).as_posix(), recursive=False)
digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
(out / 'archive.sha256').write_text(f'{digest}  {archive.name}\n')
print(f'Packaged tested source {a.sha}: {archive.name}')
