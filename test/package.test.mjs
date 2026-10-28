/** Packaging failures must preserve the previously usable helper. No GUI or compiler is started. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'perse-cua-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages/perse-cua'), { recursive: true })
  return root
}

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode })
}

for (const failure of ['sign', 'verify']) {
  test(`a ${failure} failure leaves every old app file intact`, (t) => {
    const root = fixture(t)
    copyFileSync(new URL('../scripts/build-indicator.sh', import.meta.url), join(root, 'scripts/build-indicator.sh'))
    write(join(root, 'packages/perse-cua/package.json'), '{"version":"0.3.1-rc.1"}')
    write(join(root, 'src/indicator/main.swift'), 'fixture source')
    const app = join(root, 'packages/perse-cua/bin/PerseCuaIndicator.app')
    const originals = new Map([
      ['Contents/Info.plist', 'old metadata'],
      ['Contents/MacOS/perse-cua-indicator', 'old helper'],
      ['Contents/_CodeSignature/CodeResources', 'old signature'],
    ])
    for (const [path, content] of originals) write(join(app, path), content)
    const commands = join(root, 'commands'), log = join(root, 'codesign.log')
    const outputStub = '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf candidate > "$2"; exit 0; fi; shift; done\nexit 1\n'
    write(join(commands, 'swiftc'), outputStub, 0o755)
    write(join(commands, 'lipo'), outputStub, 0o755)
    write(join(commands, 'codesign'), '#!/bin/bash\nstage=sign\nif [ "$1" = --verify ]; then stage=verify; fi\nprintf "%s\\n" "$stage" >> "$CODESIGN_LOG"\nif [ "$stage" = "$FAIL_STAGE" ]; then echo "forced $stage failure" >&2; exit 41; fi\n', 0o755)
    assert.throws(() => execFileSync('bash', [join(root, 'scripts/build-indicator.sh')], {
      cwd: root, env: { ...process.env, PATH: commands + ':' + process.env.PATH, CODESIGN_LOG: log, FAIL_STAGE: failure },
      timeout: 30000, stdio: 'pipe',
    }), (error) => error.status === 41 && error.stderr.toString().includes(`forced ${failure} failure`))
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), failure === 'sign' ? ['sign'] : ['sign', 'verify'])
    assert.deepEqual(readdirSync(app, { recursive: true }).filter(path => !['Contents', 'Contents/MacOS', 'Contents/_CodeSignature'].includes(path)).sort(), [...originals.keys()].sort())
    for (const [path, content] of originals) assert.equal(readFileSync(join(app, path), 'utf8'), content)
  })
}

test('prepack copies the exact repository documentation and license independently of cwd', (t) => {
  const root = fixture(t)
  const script = join(root, 'scripts/prepare-package-docs.mjs')
  copyFileSync(new URL('../scripts/prepare-package-docs.mjs', import.meta.url), script)
  for (const name of ['README.md', 'README.zh.md', 'LICENSE']) write(join(root, name), `source ${name}\n中文\n`)
  execFileSync(process.execPath, [script], { cwd: tmpdir(), timeout: 30000, stdio: 'pipe' })
  for (const name of ['README.md', 'README.zh.md', 'LICENSE']) {
    assert.deepEqual(readFileSync(join(root, 'packages/perse-cua', name)), readFileSync(join(root, name)))
  }
})
