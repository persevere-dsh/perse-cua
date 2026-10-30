"""Opt-in macOS regression using an owned application and the built helper."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import select
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--helper', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='perse-resize-fixture-') as directory:
    bundle = Path(directory) / 'Fixture.app' / 'Contents'
    (bundle / 'MacOS').mkdir(parents=True)
    binary = bundle / 'MacOS' / 'fixture'
    (bundle / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'fixture', 'CFBundleIdentifier': 'local.perse.resize-fixture', 'CFBundleName': 'Perse Resize Fixture', 'CFBundlePackageType': 'APPL'}))
    subprocess.run(['swiftc', str(root / 'fixture' / 'Resize.swift'), '-o', str(binary)], check=True)
    fixture = subprocess.Popen([str(binary)], stdout=subprocess.PIPE, text=True)
    helper = None
    try:
        assert fixture.stdout.readline().strip() == 'READY'
        helper = subprocess.Popen([args.helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        sequence = 0
        def call(method, params, error=None):
            global sequence
            sequence += 1
            helper.stdin.write(json.dumps({'id': str(sequence), 'method': method, 'params': params}) + '\n'); helper.stdin.flush()
            assert select.select([helper.stdout], [], [], 15)[0], 'helper timeout'
            response = json.loads(helper.stdout.readline())
            assert response['id'] == str(sequence), response
            if error:
                assert response.get('error', {}).get('code') == error, response
                return
            assert 'error' not in response, response
            return response['result']
        app = call('getApp', {'selector': str(fixture.pid)})
        handle = app['appHandle']
        window = next(w for w in call('listWindows', {'appHandle': handle}) if w['title'] == 'Perse resize fixture')
        target = {'appHandle': handle, 'windowId': window['windowId']}
        state = call('getState', {**target, 'maxElements': 300, 'maxDepth': 20})
        resize = next(e for e in state['elements'] if e['title'] == 'Resize fixture')
        call('screenshot', target)
        call('click', {'appHandle': handle, 'snapshotId': state['snapshotId'], 'elementIndex': resize['index']})
        preview = call('screenshot', {**target, 'displayOnly': True})
        assert preview['bounds']['width'] == 500, preview
        call('click', {**target, 'x': 20, 'y': 20}, 'WINDOW_CHANGED')
        call('screenshot', target)
        call('click', {**target, 'x': 20, 'y': 20})
        print('PASS: display-only resize capture preserves the prior model geometry; model screenshot refreshes it')
    finally:
        if helper:
            helper.stdin.close(); helper.wait(timeout=10)
        fixture.terminate(); fixture.wait(timeout=10)
