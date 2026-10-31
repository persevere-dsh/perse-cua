import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewFixture } from './preview-bench/state.mjs'
import { startBench } from './preview-bench/server.mjs'

test('fixture streams three windows, updates frames and sizes, and handles dismissal', async () => {
  const fixture = createPreviewFixture((title, frame, width, height) => `${title}:${frame}:${width}x${height}`)
  const stream = fixture.watch('bench'); const reader = stream[Symbol.asyncIterator]()
  assert.deepEqual((await reader.next()).value.map(item => item.title), ['Red', 'Green', 'Blue'])
  fixture.frame('bench/app/2'); fixture.resize('bench/app/2')
  assert.equal((await reader.next()).value[1].image, 'Green:1:280x420')
  fixture.setFailure(true); await assert.rejects(fixture.dismiss('bench', 'bench/app/2'))
  assert.equal(fixture.snapshot().length, 3)
  fixture.setFailure(false); await fixture.dismiss('bench', 'bench/app/2')
  assert.deepEqual((await reader.next()).value.map(item => item.title), ['Red', 'Blue'])
  fixture.reset(); assert.equal((await reader.next()).value.length, 3)
  const next = reader.next(); await stream.dispose(); assert.equal((await next).done, true)
})

test('bench serves the built client only on loopback', async t => {
  const bench = await startBench(); t.after(() => bench.close())
  assert.match(bench.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  const page = await fetch(bench.url); assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /bench\.js/); assert.match(html, /height:64px/); assert.match(html, /overflow-x:auto/)
  const script = await fetch(new URL('bench.js', bench.url)); assert.equal(script.status, 200); assert.match(await script.text(), /perse-cua\.driving/)
  assert.equal((await fetch(new URL('other', bench.url))).status, 404)
})

test('bench starts from source without existing generated artifacts', async t => {
  const { mkdtemp, mkdir, cp, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const source = fileURLToPath(new URL('..', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-clean-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'test'), { recursive: true })
  await mkdir(join(root, 'packages/perse-cua'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  for (const [from, to] of [['test/preview-bench', 'test/preview-bench'], ['packages/perse-cua/src', 'packages/perse-cua/src'], ['packages/perse-cua/client', 'packages/perse-cua/client'], ['packages/perse-cua/package.json', 'packages/perse-cua/package.json'], ['scripts/generate-remote.mjs', 'scripts/generate-remote.mjs'], ['tsconfig.base.json', 'tsconfig.base.json']]) {
    await cp(join(source, from), join(root, to), { recursive: true })
  }
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir')
  await promisify(execFile)(process.execPath, ['scripts/generate-remote.mjs'], { cwd: root })
  const { startBench: startCleanBench } = await import(pathToFileURL(join(root, 'test/preview-bench/server.mjs')).href)
  const bench = await startCleanBench()
  try { assert.equal((await fetch(new URL('bench.js', bench.url))).status, 200) }
  finally { await bench.close() }
})
