"""No sudo/systemd/server access: exercise actual extraction, hashes, and atomic links."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('netpan-release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r.ROOT = Path(self.tmp.name)
        for name in ('releases', '.staging', 'logs'):
            (r.ROOT / name).mkdir()
        self.calls = []
        r.service = lambda action: self.calls.append(action)
        r.health = lambda sha: None

    def tearDown(self):
        self.tmp.cleanup()

    def artifact(self, char):
        sha = char * 40
        files = {
            'dist/index.html': b'<html>test</html>',
            'dist-server/server/index.js': b'console.log("test")',
            'node_modules/express/package.json': b'{}',
            'version.json': json.dumps({'sha': sha, 'platform': 'linux', 'arch': 'x64', 'node': '22.23.4'}).encode(),
            'package-lock.json': b'{}',
        }
        manifest = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in files.items())
        files['SHA256SUMS'] = manifest.encode()
        archive = r.ROOT / '.staging' / f'{sha}.tar.gz'
        with tarfile.open(archive, 'w:gz') as tf:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                tf.addfile(member, io.BytesIO(data))
        return archive, sha, r.digest(archive)

    def test_deploy_and_manual_rollback(self):
        r.deploy(*self.artifact('a'))
        self.assertEqual(r.current_sha(), 'a' * 40)
        r.deploy(*self.artifact('b'))
        self.assertEqual(r.current_sha('previous'), 'a' * 40)
        r.rollback()
        self.assertEqual(r.current_sha(), 'a' * 40)
        self.assertEqual(r.current_sha('previous'), 'b' * 40)

    def test_health_failure_restores_previous(self):
        r.deploy(*self.artifact('a'))
        def health(sha):
            if sha == 'b' * 40:
                raise RuntimeError('unhealthy fixture')
        r.health = health
        with self.assertRaises(RuntimeError):
            r.deploy(*self.artifact('b'))
        self.assertEqual(r.current_sha(), 'a' * 40)
        self.assertEqual(self.calls[-2:], ['restart', 'restart'])

    def test_first_failure_stops_service(self):
        r.health = lambda sha: (_ for _ in ()).throw(RuntimeError('fail'))
        with self.assertRaises(RuntimeError):
            r.deploy(*self.artifact('a'))
        self.assertIsNone(r.current_sha())
        self.assertEqual(self.calls, ['restart', 'stop'])

    def test_restart_failure_rolls_back(self):
        r.deploy(*self.artifact('a'))
        count = 0
        def restart(action):
            nonlocal count
            count += 1
            if count == 1:
                raise RuntimeError('systemd fixture')
        r.service = restart
        with self.assertRaises(RuntimeError):
            r.deploy(*self.artifact('b'))
        self.assertEqual(r.current_sha(), 'a' * 40)

    def test_checksum_failure_does_not_switch(self):
        r.deploy(*self.artifact('a'))
        archive, sha, checksum = self.artifact('b')
        archive.write_bytes(archive.read_bytes() + b'tamper')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            r.deploy(archive, sha, checksum)
        self.assertEqual(r.current_sha(), 'a' * 40)

    def test_tampered_previous_is_rejected(self):
        r.deploy(*self.artifact('a'))
        (r.ROOT / 'releases' / ('a' * 40) / 'dist/index.html').write_text('tamper')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            r.deploy(*self.artifact('b'))

    def test_archive_traversal_and_symlink_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('safe', tarfile.SYMTYPE), ('/etc/escape', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                archive = r.ROOT / '.staging' / 'evil.tar.gz'
                with tarfile.open(archive, 'w:gz') as tf:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = '/etc/passwd'
                    tf.addfile(member, io.BytesIO(b''))
                with self.assertRaisesRegex(RuntimeError, 'unsafe archive'):
                    r.unpack(archive, r.ROOT / 'releases' / ('e' * 40), 'e' * 40, r.digest(archive))

    def test_current_outside_releases_rejected(self):
        (r.ROOT / 'current').symlink_to(r.ROOT / '.staging')
        with self.assertRaisesRegex(RuntimeError, 'invalid current'):
            r.current_sha()

    def test_public_failure_undo_first_release(self):
        r.deploy(*self.artifact('a'))
        r.undo('a' * 40)
        self.assertIsNone(r.current_sha())
        self.assertEqual(self.calls[-1], 'stop')

    def test_public_failure_undo_previous(self):
        r.deploy(*self.artifact('a'))
        r.deploy(*self.artifact('b'))
        r.undo('b' * 40)
        self.assertEqual(r.current_sha(), 'a' * 40)

    def test_undo_refuses_wrong_commit(self):
        r.deploy(*self.artifact('a'))
        with self.assertRaisesRegex(RuntimeError, 'different current'):
            r.undo('b' * 40)
        self.assertEqual(r.current_sha(), 'a' * 40)

    def test_retention_preserves_current_previous_and_caps_old_releases(self):
        for char in 'abcdef01':
            r.deploy(*self.artifact(char))
        self.assertEqual(r.current_sha(), '1' * 40)
        self.assertEqual(r.current_sha('previous'), '0' * 40)
        self.assertLessEqual(len(list((r.ROOT / 'releases').iterdir())), 5)
        self.assertEqual(len(list((r.ROOT / '.staging').iterdir())), 0)

if __name__ == '__main__':
    unittest.main(verbosity=2)
