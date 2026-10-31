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

test('fixture prestart failure releases its server and child so it can fail again and exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perse-fixture-prestart-fail-'))
  const helper = join(directory, 'fail.mjs'), source = 'process.exit(17)\n'
  try {
    await writeFile(helper, source, { mode: 0o700 })
    const script = `import assert from 'node:assert/strict'; import { startFixtureHost } from ${JSON.stringify(new URL('./fixtures/native-fixture-host.mjs', import.meta.url).href)}; for (let i = 0; i < 2; i++) await assert.rejects(startFixtureHost(process.argv[1], { prestart: true }), /Fixture service exited before readiness: 17/);`
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, helper], { timeout: 3000 })
    assert.equal(await readFile(helper, 'utf8'), source)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
