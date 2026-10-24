#!/usr/bin/env python3
"""Validate and run the real HTTP TestBot against the pruned Linux artifact."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--sha', required=True)
p.add_argument('--archive', required=True)
a = p.parse_args()
spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('netpan-release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
with tempfile.TemporaryDirectory(prefix='netpan-package-') as directory:
    r.ROOT = Path(directory)
    for name in ('.staging', 'releases'):
        (r.ROOT / name).mkdir()
    source = Path(a.archive).resolve()
    archive = r.ROOT / '.staging' / source.name
    shutil.copyfile(source, archive)
    target = r.ROOT / 'releases' / a.sha
    r.unpack(archive, target, a.sha, r.digest(source))
    env = {**os.environ, 'NETPAN_TEST_RUNTIME_ROOT': str(target)}
    subprocess.run(['node', 'tests/testbot/run.mjs'], env=env, check=True, timeout=180)
    print('Verified manifest and real HTTP TestBot against the isolated Linux package')
