"""The real service launcher fails closed before release access or Node execution."""
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import patch


class StartMountTests(unittest.TestCase):
    def test_missing_or_unreadable_mount_prevents_node_execution(self):
        for status in (32, 1):
            with self.subTest(status=status):
                with patch('subprocess.run', return_value=subprocess.CompletedProcess([], status)) as probe, patch('subprocess.check_output') as version, patch('os.execv') as execute:
                    with self.assertRaisesRegex(SystemExit, 'mount is unavailable'):
                        runpy.run_path(str(Path(__file__).with_name('netpan-start')), run_name='__main__')
                    probe.assert_called_once_with(['/usr/bin/mountpoint', '-q', '/srv/netpandownload'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    version.assert_not_called()
                    execute.assert_not_called()

    def test_failed_probe_prevents_node_execution(self):
        with patch('subprocess.run', side_effect=OSError('fixture-only probe failure')), patch('os.execv') as execute:
            with self.assertRaisesRegex(SystemExit, 'mount could not be checked'):
                runpy.run_path(str(Path(__file__).with_name('netpan-start')), run_name='__main__')
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
