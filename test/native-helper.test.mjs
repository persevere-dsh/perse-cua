import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argumentsFor, buildHelper, verifyPortable } from '../scripts/native-helper.mjs'

test('native helper build requires an explicit absolute staging path and a supported architecture', () => {
  assert.throws(() => argumentsFor([], 'build'), /Required --output/)
  assert.throws(() => argumentsFor(['--output', 'relative'], 'build'), /absolute/)
  assert.throws(() => argumentsFor(['--output', '/tmp/out', '--arch', 'ia32'], 'build'), /arm64 or x64/)
  assert.throws(() => argumentsFor(['--output', '/tmp/out', '--require-developer-id'], 'build'), /signing identity/)
  assert.equal(argumentsFor(['--output', '/tmp/out', '--arch', 'x64'], 'build').arch, 'x64')
})

test('portable helper verification rejects a stale source digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perse-native-manifest-'))
  try {
    const root = 'packages/perse-cua/native/bin/darwin-arm64'
    const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'))
    manifest.sourceSha256 = 'stale'
    const path = join(directory, 'manifest.json')
    await writeFile(path, JSON.stringify(manifest))
    await assert.rejects(verifyPortable({ binary: `${root}/dsh-cua-native`, arch: 'arm64', manifest: path }), /does not match/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native helper builder rejects other platforms before invoking a compiler', async () => {
  if (process.platform === 'darwin') return
  await assert.rejects(buildHelper({ arch: 'arm64', output: '/tmp/out', signIdentity: '-', requireDeveloperId: false }), /requires macOS/)
})
