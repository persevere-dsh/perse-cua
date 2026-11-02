"""Desktop-free tests for isolated fixture staging and stable identities."""
import importlib.util
import plistlib
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('hover_fixture_run', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FixturePreparationTests(unittest.TestCase):
    def test_fixture_is_discoverable_without_requesting_activation(self):
        info = plistlib.loads(runner.FIXTURE_PLIST.encode())
        self.assertFalse(info.get('LSUIElement', False))
        source = Path(__file__).with_name('Fixture.swift').read_text()
        self.assertIn('app.setActivationPolicy(.regular)', source)
        self.assertIn('guard app.activationPolicy() == .regular', source)
        self.assertNotIn('guard app.setActivationPolicy', source)
        self.assertNotIn('activate(', source)
        self.assertIn('frontmostApplication?.processIdentifier == fixture.initialFront', source)

    def test_helper_identity_is_reused_until_bytes_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = runner.prepare_root(Path(tmp) / 'identity')
            source = Path(tmp) / 'source'
            source.write_bytes(b'first')
            source.chmod(0o755)
            target = root / 'dsh-cua-native'
            first_hash = runner.stage_helper(source, target)
            first_inode = target.stat().st_ino
            self.assertEqual(first_hash, runner.stage_helper(source, target))
            self.assertEqual(first_inode, target.stat().st_ino)
            source.write_bytes(b'second')
            self.assertNotEqual(first_hash, runner.stage_helper(source, target))
            self.assertEqual(target.read_bytes(), b'second')

    def test_root_refuses_unowned_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'existing'
            root.mkdir()
            (root / 'user-file').write_text('leave intact')
            with self.assertRaises(ValueError):
                runner.prepare_root(root)
            self.assertEqual((root / 'user-file').read_text(), 'leave intact')
            link = Path(tmp) / 'link'
            link.symlink_to(root)
            with self.assertRaises(ValueError):
                runner.prepare_root(link)

    def test_default_run_refuses_desktop_change_before_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'identity'
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')),
                                     '--helper', '/nonexistent/helper', '--test-root', str(root)],
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Cannot guarantee a real fixture leaves the desktop unchanged', result.stderr)
            self.assertFalse(root.exists())

    def test_staging_rejects_symlink_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = runner.prepare_root(Path(tmp) / 'identity')
            source = Path(tmp) / 'source'
            source.write_bytes(b'new')
            victim = Path(tmp) / 'victim'
            victim.write_bytes(b'old')
            target = root / 'dsh-cua-native'
            target.symlink_to(victim)
            with self.assertRaises(ValueError):
                runner.stage_helper(source, target)
            self.assertEqual(victim.read_bytes(), b'old')


    def test_visual_frames_require_negotiation_matching_identity_and_order(self):
        request = {'id': '1', 'method': 'click', 'params': {'appHandle': 'app'}}
        frame = {'type': 'visual', 'requestId': '1', 'appHandle': 'app', 'windowId': 7,
                 'sequence': 1, 'phase': 'move'}
        old = runner.VisualFrames(False)
        old.register(request)
        with self.assertRaises(AssertionError):
            old.observe(frame, '1')
        validator = runner.VisualFrames(True)
        validator.window_id = 7
        validator.register(request)
        self.assertTrue(validator.observe(frame, '1'))
        with self.assertRaises(AssertionError):
            validator.observe(frame, '1')
        with self.assertRaises(AssertionError):
            validator.require('1', ('move', 'click'))
        with self.assertRaises(AssertionError):
            validator.observe({**frame, 'sequence': 2, 'windowId': 8}, '1')
        with self.assertRaises(AssertionError):
            validator.observe({**frame, 'sequence': 2, 'appHandle': 'other'}, '1')
        with self.assertRaises(AssertionError):
            validator.observe({**frame, 'sequence': 2, 'requestId': 'unknown'}, '1')
        self.assertTrue(validator.observe({**frame, 'sequence': 2, 'phase': 'click'}, '1'))
        validator.require('1', ('move', 'click'))
        validator.register({'id': '2', 'method': 'getState', 'params': {'appHandle': 'app'}})
        self.assertTrue(validator.observe({**frame, 'sequence': 3, 'phase': 'clear'}, '2'))
        with self.assertRaises(AssertionError):
            validator.observe({**frame, 'sequence': 4}, '2')

    def test_visual_phases_must_arrive_in_order(self):
        validator = runner.VisualFrames(True)
        validator.window_id = 7
        validator.register({'id': '1', 'params': {'appHandle': 'app'}})
        base = {'type': 'visual', 'requestId': '1', 'appHandle': 'app', 'windowId': 7}
        validator.observe({**base, 'sequence': 1, 'phase': 'click'}, '1')
        validator.observe({**base, 'sequence': 2, 'phase': 'move'}, '1')
        with self.assertRaises(AssertionError):
            validator.require('1', ('move', 'click'))


if __name__ == '__main__':
    unittest.main()
