#!/usr/bin/env python3
"""Opt-in isolated macOS helper/fixture test; never shares the user's helper socket."""
import argparse
import fcntl
import hashlib
import json
import os
import shutil
import socket
import stat
import subprocess
import tempfile
import time
from pathlib import Path


def wait_for(check, description, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.03)
    raise RuntimeError(f"Timed out waiting for {description}")


def stop_owned(process):
    if process is None:
        return
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


FIXTURE_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>local.perse.isolated-hover-fixture</string><key>CFBundleName</key><string>Perse isolated hover fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"""
MARKER = '.perse-hover-fixture-owner'


def prepare_root(root):
    if not root.is_absolute() or root.is_symlink():
        raise ValueError('Test root must be an absolute non-symlink path')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Test root must be a private directory owned by the current user')
    marker = root / MARKER
    if marker.is_symlink() or (not marker.exists() and any(root.iterdir())):
        raise ValueError('Test root must be empty or already owned by this fixture')
    if not marker.exists():
        marker.write_text('perse-cua isolated hover fixture v1\n')
    if marker.read_text() != 'perse-cua isolated hover fixture v1\n':
        raise ValueError('Test root ownership marker is invalid')
    return root


def stage_helper(source, destination):
    if destination.is_symlink():
        raise ValueError('Refusing a symlink helper target')
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != source_hash:
        temporary = destination.with_name('.helper-staging')
        if temporary.exists() or temporary.is_symlink():
            raise ValueError('Stale helper staging file must be removed explicitly')
        try:
            shutil.copy2(source, temporary)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    return source_hash


def prepare_fixture(root, source):
    bundle = root / 'HoverFixture.app'
    executable = bundle / 'Contents' / 'MacOS' / 'fixture'
    stamp = root / '.fixture-source.sha256'
    order_source = source.with_name('WindowOrder.swift')
    digest = hashlib.sha256(source.read_bytes() + order_source.read_bytes() + FIXTURE_PLIST.encode()).hexdigest()
    if executable.is_file() and stamp.is_file() and stamp.read_text() == digest:
        subprocess.run(['codesign', '--verify', '--strict', str(bundle)], check=True)
        return executable
    stage = root / '.fixture-build'
    if stage.exists() or stage.is_symlink():
        raise ValueError('Stale fixture build directory must be removed explicitly')
    staged_app = stage / 'HoverFixture.app'
    staged_executable = staged_app / 'Contents' / 'MacOS' / 'fixture'
    staged_executable.parent.mkdir(parents=True)
    try:
        (staged_app / 'Contents' / 'Info.plist').write_text(FIXTURE_PLIST)
        subprocess.run(['swiftc', str(source), str(order_source), '-o', str(staged_executable)], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(staged_app)], check=True)
        subprocess.run(['codesign', '--verify', '--strict', str(staged_app)], check=True)
        if bundle.exists():
            shutil.rmtree(bundle)
        os.rename(staged_app, bundle)
        stamp.write_text(digest)
    finally:
        shutil.rmtree(stage)
    return executable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', required=True, type=Path, help='An explicit built native helper')
    parser.add_argument('--test-root', type=Path, default=Path.home() / 'Library/Caches/perse-cua-hover-fixture',
                        help='Stable isolated fixture directory (default: ~/Library/Caches/perse-cua-hover-fixture)')
    parser.add_argument('--prepare-only', action='store_true', help='Build and stage identities without starting any GUI or helper')
    parser.add_argument('--allow-desktop-change', action='store_true', help='Explicitly allow a background test window and cursor feedback to change the desktop')
    args = parser.parse_args()
    if not args.prepare_only and not args.allow_desktop_change:
        parser.error('Cannot guarantee a real fixture leaves the desktop unchanged; explicit --allow-desktop-change is required')
    asset_root = prepare_root(args.test_root)
    lock = os.fdopen(os.open(asset_root / '.run.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise RuntimeError('An isolated fixture run already owns this test root') from error
    helper = asset_root / 'dsh-cua-native'
    key = stage_helper(args.helper.resolve(strict=True), helper)
    executable = prepare_fixture(asset_root, Path(__file__).with_name('Fixture.swift'))
    if args.prepare_only:
        print(f'Prepared helper {helper} (SHA-256 {key}) and fixture {executable.parent.parent.parent}; no processes started')
        return
    # Every run uses its own short socket directory, regardless of helper digest.
    with tempfile.TemporaryDirectory(prefix='ph-', dir='/tmp') as temp:
        root = Path(temp)
        runtime = root / 'r'
        state_path = root / 'state.json'
        fixture = helper_process = connection = stream = None
        try:
            fixture = subprocess.Popen([str(executable), str(state_path)], stdin=subprocess.DEVNULL)
            wait_for(state_path.exists, 'fixture startup')
            initial = json.loads(state_path.read_text())
            if initial['cursorChanged'] or initial['frontChanged']:
                raise RuntimeError('Desktop changed during fixture startup; retry only when idle')
            helper_process = subprocess.Popen([str(helper), '--serve', '--runtime-key', key,
                '--runtime-directory', str(runtime), '--startup-timeout-ms', '10000'], stdin=subprocess.DEVNULL)
            socket_path = runtime / f'{key}.sock'
            wait_for(socket_path.exists, 'isolated helper socket')
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.settimeout(15)
            connection.connect(str(socket_path))
            stream = connection.makefile('rwb', buffering=0)
            def send(value):
                stream.write(json.dumps(value, separators=(',', ':')).encode() + b'\n')
            def read():
                line = stream.readline()
                if not line:
                    raise RuntimeError('Helper closed the isolated connection')
                return json.loads(line)
            send({'type': 'hello', 'protocol': 1, 'runtimeKey': key, 'config': {
                'maxRequestBytes': 1048576, 'maxResponseBytes': 33554432, 'axTimeoutMs': 3000,
                'textEventIntervalMs': 0.25, 'screenshotTimeoutMs': 5000, 'timeoutMs': 15000, 'graceMs': 1000}})
            ready = read()
            assert ready.get('type') == 'ready' and ready.get('runtimeKey') == key, ready
            seq = 0
            def call(method, params, expected_error=None):
                nonlocal seq
                seq += 1
                send({'id': str(seq), 'method': method, 'params': params})
                while True:
                    response = read()
                    if response.get('type') == 'diagnostic':
                        continue
                    break
                assert response.get('id') == str(seq), response
                if expected_error:
                    assert response.get('error', {}).get('code') == expected_error, response
                    return
                if 'error' in response:
                    raise RuntimeError(f'{method}: {response["error"]}')
                return response['result']
            capabilities = call('getCapabilities', {})
            if not capabilities['permissions']['accessibility']:
                raise RuntimeError('Accessibility permission is required for the isolated helper')
            owner = {'appHandle': call('getApp', {'selector': str(fixture.pid)})['appHandle']}
            window = wait_for(lambda: next((w for w in call('listWindows', owner)
                if w['title'] == 'Perse isolated hover fixture'), None), 'fixture window')
            scope = {**owner, 'windowId': window['windowId'], 'maxDepth': 20, 'maxElements': 100}
            def target(label):
                observed = call('getState', scope)
                matches = [item for item in observed['elements'] if item.get('description') == label or item.get('title') == label]
                assert len(matches) == 1, (label, observed['tree'])
                return {**owner, 'snapshotId': observed['snapshotId'], 'elementIndex': matches[0]['index']}
            result = call('hover', target('Alternate hover'))
            assert result == {'dispatched': True, 'verified': False, 'hoverRoute': 'accessibility', 'systemPointerMoved': False}, result
            wait_for(lambda: json.loads(state_path.read_text())['alternateShown'], 'AX alternate reveal')
            result = call('hover', target('Alternate child'))
            assert result['hoverRoute'] == 'accessibility' and result['systemPointerMoved'] is False, result
            call('click', target('Alternate child'))
            wait_for(lambda: json.loads(state_path.read_text())['clicks'] == 1, 'AX child click')
            before = json.loads(state_path.read_text())
            call('hover', target('Tracking only'), 'UNSUPPORTED')
            final = wait_for(lambda: (s if (s := json.loads(state_path.read_text()))['restores'] == 1 else None), 'AX alternate restore')
            assert not final['alternateShown'] and final['reveals'] == 1, final
            assert final['trackingEntries'] == before['trackingEntries'], final
            assert not final['cursorChanged'] and not final['frontChanged'], final
            print('PASS: AX alternate reveal, child, restore and tracking-only UNSUPPORTED; cursor and foreground unchanged')
        finally:
            if stream:
                stream.close()
            if connection:
                connection.close()
            stop_owned(helper_process)
            stop_owned(fixture)


if __name__ == '__main__':
    main()
