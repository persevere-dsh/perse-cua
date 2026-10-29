import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import { apply } from '../packages/perse-cua/lib/index.js'
import { Context } from '@deepseek-ai/cordis'

const fixture = new URL('./fixtures/indicator-process.mjs', import.meta.url)
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check, description) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await pause(10)
  }
}

function harness(t, settings = {}, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'perse-cua-indicator-'))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings))
  writeFileSync(path.join(root, 'events.jsonl'), '')
  // A private PATH entry intercepts open. This test must never launch a GUI.
  writeFileSync(path.join(bin, 'open'), `#!/usr/bin/env node\nimport { launch } from ${JSON.stringify(fixture.href)};\nawait launch(${JSON.stringify(root)});\n`, { mode: 0o755 })
  const originalPath = process.env.PATH
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  process.env.PATH = `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${originalPath ?? ''}`
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const events = () => readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const ofType = type => events().filter(event => event.type === type)
  const stateFile = path.join(root, 'indicator.json')
  const tools = new Map()
  const ctx = new Context()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, {
    command: process.execPath, args: [fileURLToPath(fixture), 'mcp', root],
    bestExperience: false, indicator: true, indicatorStateFile: stateFile,
    requestTimeoutMs: 1000, startupTimeoutMs: 1000, ...config,
  })
  t.after(async () => {
    dispose()
    // Failed assertions must not leave fixture processes running.
    rmSync(stateFile, { force: true })
    for (const event of events()) {
      if (event.type === 'launcher' || event.type === 'helper-ready') {
        try { process.kill(event.pid) } catch { /* Already reaped. */ }
      }
    }
    await pause(50)
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  })
  return { root, stateFile, tools, dispose, events, ofType }
}

test('indicator recovers on the next action after the idle helper exits', async t => {
  const h = harness(t, { exitBarrier: true })
  await until(() => h.ofType('helper-ready').length === 1, 'initial helper')
  const firstPid = h.ofType('helper-ready')[0].pid
  const state = JSON.parse(readFileSync(h.stateFile, 'utf8'))
  writeFileSync(h.stateFile, JSON.stringify({ ...state, ts: Date.now() / 1000 - 61 }))
  await until(() => h.ofType('launcher-waiting').length === 1, 'launcher waits after helper exit')
  assert.equal(h.ofType('launcher-exit').length, 0, 'action arrives before the launcher exits')
  await h.tools.get('mcp__cua__list_apps').execute({})
  assert.equal(h.ofType('launcher').length, 1, 'read-only calls do not restart the indicator')
  const result = await h.tools.get('mcp__cua__click').execute({})
  assert.equal(result.blocks[0].text, 'fixture tool result')
  writeFileSync(path.join(h.root, 'release-launcher'), '')
  await until(() => h.ofType('helper-ready').length === 2, 'replacement helper')
  assert.notEqual(h.ofType('helper-ready')[1].pid, firstPid)
  assert.equal(JSON.parse(readFileSync(h.stateFile, 'utf8')).active, true)
  assert.ok(h.ofType('launcher').every(event => event.args.includes('-W')))
})

test('indicator launch failure is cosmetic and the next action retries', async t => {
  const h = harness(t, { failedLaunches: 1 })
  await until(() => h.ofType('launch-failed').length === 1, 'failed launch')
  await until(() => !alive(h.ofType('launcher')[0].pid), 'failed launcher exits')
  await pause(30)
  assert.equal((await h.tools.get('mcp__cua__click').execute({})).blocks[0].text, 'fixture tool result')
  await until(() => h.ofType('helper-ready').length === 1, 'retry helper')
  assert.equal(h.ofType('launcher').length, 2)
})

test('concurrent actions share one pending indicator launch', async t => {
  const h = harness(t, { launchDelayMs: 150 })
  await until(() => h.ofType('launcher').length === 1, 'pending launch')
  await Promise.all(Array.from({ length: 20 }, () => h.tools.get('mcp__cua__click').execute({})))
  await until(() => h.ofType('helper-ready').length === 1, 'single helper')
  assert.equal(h.ofType('launcher').length, 1)
})

test('dispose ends the launcher, removes state and prevents later activity from reviving it', async t => {
  const h = harness(t)
  await until(() => h.ofType('helper-ready').length === 1, 'initial helper')
  const action = h.tools.get('mcp__cua__click')
  await action.execute({})
  const launcherPid = h.ofType('launcher')[0].pid
  const helperPid = h.ofType('helper-ready')[0].pid
  h.dispose()
  h.dispose()
  await until(() => !alive(launcherPid) && !alive(helperPid), 'owned processes exit')
  assert.equal(existsSync(h.stateFile), false)
  await assert.rejects(action.execute({}))
  await pause(2600)
  assert.equal(existsSync(h.stateFile), false, 'no idle timer recreates disposed state')
  assert.equal(h.ofType('launcher').length, 1)
  assert.equal(h.tools.size, 0)
})

test('dispose during asynchronous boot prevents a delayed indicator launch', async t => {
  const h = harness(t, { sessionDelayMs: 200 }, { bestExperience: true })
  await until(() => h.events().some(event => event.type === 'tool-call' && event.name === 'start_session'), 'pending cursor setup')
  h.dispose()
  await pause(300)
  assert.equal(h.ofType('launcher').length, 0)
  assert.equal(existsSync(h.stateFile), false)
})

test('disabled indicator does not launch or write state during tool calls', async t => {
  const h = harness(t, {}, { indicator: false })
  await until(() => h.tools.has('mcp__cua__click'), 'tool registration')
  await h.tools.get('mcp__cua__click').execute({})
  assert.equal(h.ofType('launcher').length, 0)
  assert.equal(existsSync(h.stateFile), false)
})
