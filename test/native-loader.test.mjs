import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Prompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { initProfile, mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import * as Main from '../packages/perse-cua/lib/index.js'
import { startFixtureHost } from './fixtures/native-fixture-host.mjs'

async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10) }
  throw new Error('Loader did not reach the expected state')
}
async function host() {
  const ctx = new Context()
  for (const plugin of [Loader, Tools, Agents, Prompt, Subprocess]) await ctx.plugin(plugin)
  ctx.loader.builtins.perse = Main
  return ctx
}

test('macOS legacy driver settings require an explicit MCP backend', { skip: process.platform !== 'darwin' }, () => {
  const ctx = new Context()
  assert.throws(() => Main.apply(ctx, { command: '/fixture' }), /require backend: mcp explicitly/)
  assert.throws(() => Main.apply(ctx, { allow: ['click'] }), /require backend: mcp explicitly/)
  assert.throws(() => Main.apply(ctx, { backend: 'native', args: [] }), /cannot use MCP driver settings/)
  assert.throws(() => Main.apply(ctx, { backend: 'native', helperPath: '/nonexistent/perse-cua-helper' }), /unavailable or not executable/)
})

test('an existing native provider rejects a second provider before activation', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = await host()
  try {
    await ctx.plugin(ComputerUse)
    const stop = ctx.computerUse.register('existing')
    assert.throws(() => Main.apply(ctx, {}), /already registered/)
    assert.equal(ctx.tools.get('cua'), undefined)
    await stop()
  } finally { await ctx.fiber.dispose() }
})

test('missing helper makes the loader entry fail instead of starting MCP', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = await host()
  try {
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: '/nonexistent/perse-cua-helper' } })
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('perse-cua').fiber
    assert.equal(fiber.state, 3)
    await assert.rejects(fiber.await(), /unavailable or not executable/)
    assert.equal(ctx.tools.get('cua'), undefined)
    assert.equal(ctx.tools.get('mcp__cua__get_window_state'), undefined)
  } finally { await ctx.fiber.dispose() }
})

test('a provider that wins while dependencies load produces an explicit startup error', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = new Context(), errors = [], previous = console.error
  try {
    console.error = (...args) => { errors.push(args.map(String).join(' ')) }
    for (const plugin of [Loader, ComputerUse, Tools, Agents, Prompt]) await ctx.plugin(plugin)
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: {} })
    await ctx.loader.await()
    const stop = ctx.computerUse.register('other')
    await ctx.plugin(Subprocess)
    await waitFor(() => errors.some(message => /Native provider failed to start/.test(message)))
    assert.equal(ctx.computerUse.providerName, 'other')
    assert.equal(ctx.tools.get('cua'), undefined)
    await stop()
  } finally { console.error = previous; await ctx.fiber.dispose() }
})

test('macOS default and explicit MCP use one loader entry and stop on disable', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = await host()
  const root = await mkdtemp(join(tmpdir(), 'perse-loader-'))
  try {
    const log = join(root, 'calls'), expired = join(root, 'expired')
    await writeFile(log, '')
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: {} })
    await ctx.loader.await()
    await waitFor(() => ctx.computerUse?.providerName === 'dsh-cua' && ctx.tools.get('cua'))
    assert.equal(ctx.tools.get('mcp__cua__get_window_state'), undefined)
    const removeSkillCatalog = ctx.systemPrompt.section({ name: 'fixture:skill-catalog', order: 0, text: 'Available skill: cua-driver (CLI or MCP). Load the skill for GUI tasks.' })
    const guidance = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(guidance, /prefer the registered cua tool and its application authorization flow/ )
    assert.match(guidance, /Available skill: cua-driver/ )
    assert.match(guidance, /Do not load the external cua-driver skill for native cua/ )
    assert.match(guidance, /do not apply its CLI or MCP parameters to cua; follow the cua tool schema and native guidance/ )
    assert.match(guidance, /typed browser tabs is unavailable/ )
    assert.match(guidance, /Do not switch providers to bypass denied or revoked access/ )
    const entry = ctx.loader.resolve('perse-cua'), fiber = entry.fiber
    const grants = fiber.config.allowedApps
    await ctx.loader.update('perse-cua', { config: { allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture' }] } })
    await ctx.loader.await()
    assert.equal(entry.fiber, fiber)
    assert.equal(grants.get()[0].name, 'Fixture')
    const fixture = fileURLToPath(new URL('./fixtures/session-driver.mjs', import.meta.url))
    await ctx.loader.update('perse-cua', { config: { backend: 'mcp', command: process.execPath, args: [fixture, log, expired], indicator: false, bestExperience: false } })
    await ctx.loader.await()
    await waitFor(() => ctx.tools.get('mcp__cua__get_window_state'))
    assert.ok(ctx.tools.get('mcp__cua__browser_navigate'))
    await ctx.tools.get('mcp__cua__browser_navigate').execute({ url: 'https://example.test' })
    assert.match(await readFile(log, 'utf8'), /browser_navigate/ )
    assert.equal(ctx.tools.get('cua'), undefined)
    const mcpGuidance = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(mcpGuidance, /Available skill: cua-driver/ )
    assert.doesNotMatch(mcpGuidance, /Do not load the external cua-driver skill for native cua/ )
    removeSkillCatalog()
    assert.equal(ctx.get('computerUse'), undefined)
    await ctx.loader.update('perse-cua', { disabled: true })
    await ctx.loader.await()
    assert.equal(ctx.tools.get('mcp__cua__get_window_state'), undefined)
    assert.equal(ctx.tools.get('cua'), undefined)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('native entry reuses host registry, suspends on removal, and resumes on return', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = await host()
  try {
    const registry = await ctx.plugin(ComputerUse)
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: {} })
    await ctx.loader.await()
    await waitFor(() => ctx.computerUse?.providerName === 'dsh-cua')
    await registry.dispose()
    await waitFor(() => ctx.get('computerUse') === undefined && ctx.tools.get('cua') === undefined)
    const replacement = await ctx.plugin(ComputerUse)
    await waitFor(() => ctx.computerUse?.providerName === 'dsh-cua')
    await ctx.loader.update('perse-cua', { disabled: true })
    await ctx.loader.await()
    assert.ok(ctx.get('computerUse'))
    assert.equal(ctx.computerUse.providerName, undefined)
    await replacement.dispose()
  } finally { await ctx.fiber.dispose() }
})

test('native application access requires a task approval before fixture observation', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-consent-'))
  const helper = join(root, 'native-helper.mjs')
  const source = await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8')
  await writeFile(helper, `${source}\n// Fixture directory: ${JSON.stringify(root)}\n`, { mode: 0o700 })
  await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper)
  const ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    let selected = 'Deny'
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: [selected] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper } })
    await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const tool = ctx.tools.get('cua')
    const deniedAgent = { id: 'denied', ctx }
    const allowedAgent = { id: 'allowed', ctx }
    const agents = new Map([[deniedAgent.id, deniedAgent], [allowedAgent.id, allowedAgent]])
    ctx.agents.get = id => agents.get(id)
    const execution = agent => ({ agent, signal: new AbortController().signal, callId: 'fixture-call' })
    await assert.rejects(tool.execute({ method: 'getApp', params: { selector: 'Fixture' } }, execution(deniedAgent)), /denied/i)
    const events = () => readFile(join(root, 'helper-events.jsonl'), 'utf8').then(text => text.trim().split('\n').map(JSON.parse))
    assert.equal((await events()).some(event => event.method === 'getState'), false)
    selected = 'Allow for this task'
    const app = await tool.execute({ method: 'getApp', params: { selector: 'Fixture' } }, execution(allowedAgent))
    const state = await tool.execute({ method: 'getState', params: { appHandle: app.appHandle, windowId: 7 } }, execution(allowedAgent))
    assert.equal(state.windowId, 7)
    assert.equal((await events()).some(event => event.method === 'getState'), true)
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('saved fixture consent is written to the loader entry and reused after restart', { skip: process.platform !== 'darwin' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'perse-saved-consent-')), dir = join(home, 'profile')
  const helper = join(home, 'native-helper.mjs')
  const source = await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8')
  await writeFile(helper, `${source}\n// Fixture directory: ${JSON.stringify(home)}\n`, { mode: 0o700 })
  const closeHost = await startFixtureHost(helper)
  const contexts = []
  try {
    initProfile(dir, ['perse-fixture-bundle'])
    const bundle = join(dir, 'node_modules', 'perse-fixture-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(home, 'package.json'), '{"name":"fixture-installation"}\n')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'perse-fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper } }] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const profile = { name: 'test', startedBundles: ['perse-fixture-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    async function open(answer) {
      const ctx = new Context(); contexts.push(ctx)
      ctx.baseUrl = pathToFileURL(home).href + '/'
      ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: [answer] }] } } })
      for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess, ConfigEditor]) await ctx.plugin(plugin)
      ctx.loader.builtins.perse = Main
      await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
      await ctx.loader.await()
      await ctx.plugin(Settings)
      await waitFor(() => ctx.tools.get('cua') && ctx.get('settings'))
      const agent = { id: 'fixture-agent', ctx }
      ctx.agents.get = id => id === agent.id ? agent : undefined
      return { ctx, agent, tool: ctx.tools.get('cua') }
    }
    const first = await open('Always allow')
    await first.tool.execute({ method: 'getApp', params: { selector: 'Fixture' } }, { agent: first.agent, signal: new AbortController().signal, callId: 'first' })
    assert.match(await readFile(profile.patchPath, 'utf8'), /a{64}/)
    assert.ok(first.ctx.settings.describe().some(item => item.ns === 'perse-cua'))
    await first.ctx.fiber.dispose()
    const second = await open('Deny')
    const app = await second.tool.execute({ method: 'getApp', params: { selector: 'Fixture' } }, { agent: second.agent, signal: new AbortController().signal, callId: 'second' })
    assert.ok(app.appHandle)
  } finally {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await closeHost()
    await rm(home, { recursive: true, force: true })
  }
})

test('native preview captures an authorized window without changing model coordinates', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-'))
  const helper = join(root, 'native-helper.mjs')
  const source = await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8')
  await writeFile(helper, source, { mode: 0o700 })
  await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper)
  const ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } })
    await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'preview-agent', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let sequence = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `preview-${++sequence}`, signal: new AbortController().signal })
    const invalid = await call('getCapabilities', '{')
    assert.equal(invalid.isError, true)
    assert.match(JSON.stringify(invalid.error), /params must be a JSON object/)
    for (const params of ['null', '[]', '42', '\"text\"']) {
      const rejected = await call('getCapabilities', params)
      assert.equal(rejected.isError, true)
      assert.match(JSON.stringify(rejected.error), /params must be a JSON object/)
    }
    const capability = await call('getCapabilities', '{}')
    assert.equal(capability.isError, false)
    const app = await call('getApp', JSON.stringify({ selector: 'Fixture' }))
    assert.equal(app.isError, false)
    const state = await call('getState', JSON.stringify({ appHandle: app.value.appHandle, windowId: 7 }))
    assert.equal(state.isError, false)
    const hoverTarget = { appHandle: app.value.appHandle, snapshotId: state.value.snapshotId, elementIndex: 0 }
    const reveal = await call('hover', hoverTarget)
    assert.equal(reveal.isError, false)
    assert.equal(reveal.value.dispatched, true)
    const retained = await call('hover', hoverTarget)
    assert.equal(retained.isError, false)
    assert.equal(retained.value.dispatched, false)
    assert.equal(retained.value.verified, false)
    assert.equal(retained.value.hoverRoute, 'accessibility')
    const view = ctx.get('perseCuaView'); const reader = view.watch(agent.id, new AbortController().signal)[Symbol.asyncIterator]()
    let items = (await reader.next()).value
    if (!items[0]?.image) items = (await reader.next()).value
    assert.match(items[0].image, /^data:image\/png;base64,/)
    const events = (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.method === 'screenshot' && event.params.displayOnly === true))
    const second = await call('getState', { appHandle: app.value.appHandle, windowId: 8 })
    assert.equal(second.isError, false)
    while (!items.some(item => item.id.endsWith('/8') && item.image)) items = (await reader.next()).value
    assert.equal(items.length, 2)
    const click = await call('click', { appHandle: app.value.appHandle, windowId: 7, snapshotId: state.value.snapshotId, x: 10, y: 10 })
    assert.equal(click.isError, true)
    assert.match(JSON.stringify(click.error), /SCREENSHOT_REQUIRED/)
    const refreshed = await call('getState', { appHandle: app.value.appHandle, windowId: 7 })
    assert.equal(refreshed.isError, false)
    while (!items.some(item => item.id.endsWith('/7') && item.image)) items = (await reader.next()).value
    await ctx.loader.update('perse-cua', { config: { helperPath: helper, allowedApps: [] } })
    await ctx.loader.await()
    while (items.length !== 0) items = await Promise.race([reader.next().then(x => x.value), new Promise((_, reject) => setTimeout(() => reject(new Error('revoke timeout')), 2000))])
    assert.deepEqual(items, [])
    await reader.return()
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('unrelated native reads wait for slow automatic discovery without cancelling it', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-read-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('    input.on(\'line\', line => {', "    const delayed = new Map()\n    input.on('line', line => {")
    .replace("      if (request.type === 'cancel') {", "      if (request.type === 'cancel') {\n        const timer = delayed.get(request.id)\n        if (timer) { clearTimeout(timer); delayed.delete(request.id); scopedRecord('slow-cancel', { id: request.id }); socket.write(JSON.stringify({ id: request.id, error: { code: 'NATIVE_CANCELLED', message: 'cancelled' } }) + '\\n') }")
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('slow-start', { id: request.id })\n        const timer = setTimeout(() => { delayed.delete(request.id); try { socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n') } catch (error) { socket.write(JSON.stringify({ id: request.id, error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } }) + '\\n') } }, existsSync(new URL('./slow-duration', import.meta.url)) ? Number(readFileSync(new URL('./slow-duration', import.meta.url), 'utf8')) : 180)\n        delayed.set(request.id, timer); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper); const ctx = new Context()
  const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 1000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } })
    await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'read-test', ctx }, other = { id: 'other-read-test', ctx }
    ctx.agents.get = id => id === agent.id ? agent : id === other.id ? other : undefined
    let sequence = 0
    const call = (method, params = {}, owner = agent, signal = new AbortController().signal) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent: owner, callId: `read-${++sequence}`, signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false)
    const controller = new AbortController(); const reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    await reader.next()
    for (let i = 0; i < 300 && !(await events()).some(row => row.event === 'slow-start'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'slow-start'))
    const cancelled = new AbortController()
    const read = call('getCapabilities', {}, agent, cancelled.signal).then(() => 'done', () => 'done')
    await delay(5); cancelled.abort()
    assert.equal(await Promise.race([read, delay(80).then(() => 'timeout')]), 'done')
    const controllers = Array.from({ length: 30 }, () => new AbortController())
    const abandoned = controllers.map(ctrl => call('getCapabilities', {}, agent, ctrl.signal).then(() => 'done', () => 'done'))
    await delay(5); for (const ctrl of controllers) ctrl.abort()
    assert.equal((await Promise.race([Promise.all(abandoned), delay(80).then(() => [])])).length, controllers.length)
    assert.equal((await events()).filter(row => row.method === 'getCapabilities').length, 0)
    assert.equal((await call('getCapabilities', {}, other)).isError, false)
    for (const method of ['getCapabilities', 'listApps', 'getCapabilities']) assert.equal((await call(method)).isError, false)
    let observed = await events()
    assert.equal(observed.filter(row => row.event === 'slow-cancel').length, 0)
    assert.ok(observed.some(row => row.method === 'listWindows' && row.params.displayOnly))
    const deadline = Date.now() + 5000
    let reads = 0
    while (Date.now() < deadline) {
      assert.equal((await call(reads++ % 2 ? 'listApps' : 'getCapabilities')).isError, false)
      observed = await events()
      if (observed.filter(row => row.method === 'screenshot' && row.params.displayOnly).length >= 2) break
      await delay(30)
    }
    assert.ok(observed.filter(row => row.method === 'screenshot' && row.params.displayOnly).length >= 2, 'automatic previews stopped during reads')
    assert.equal(observed.filter(row => row.event === 'slow-cancel').length, 0)
    const starts = observed.filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= starts; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > starts)
    const queuedRead = call('listApps')
    const operation = call('getState', { appHandle: app.value.appHandle, windowId: 7 })
    const [readResult, stateResult] = await Promise.all([queuedRead, operation])
    assert.equal(stateResult.isError, false); assert.equal(readResult.isError, false)
    assert.ok((await events()).some(row => row.event === 'slow-cancel'))
    await writeFile(join(root, 'slow-duration'), '3000')
    const beforeDeadline = (await events()).filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= beforeDeadline; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > beforeDeadline)
    const started = Date.now()
    assert.equal((await call('getCapabilities')).isError, false)
    assert.ok(Date.now() - started < 2400, 'passive read exceeded its configured wait and cleanup budget')
    const beforeRevoke = (await events()).filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= beforeRevoke; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > beforeRevoke)
    const revokedRead = call('listApps').then(() => 'done', () => 'done')
    await delay(5)
    await ctx.loader.update('perse-cua', { config: { helperPath: helper, timeoutMs: 1000, previewRefreshIntervalMs: 1000, allowedApps: [] } })
    assert.equal(await Promise.race([revokedRead, delay(500).then(() => 'timeout')]), 'done')
    await ctx.loader.await()
    const otherApp = await call('getApp', { selector: 'Fixture' }, other); assert.equal(otherApp.isError, false, JSON.stringify(otherApp))
    const otherController = new AbortController(); const otherReader = ctx.get('perseCuaView').watch(other.id, otherController.signal)[Symbol.asyncIterator]()
    await otherReader.next()
    const beforeDispose = (await events()).filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= beforeDispose; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > beforeDispose)
    const closingRead = call('listApps', {}, other).then(() => 'done', () => 'done')
    await delay(5)
    const shutdown = ctx.fiber.dispose()
    assert.equal(await Promise.race([closingRead, delay(500).then(() => 'timeout')]), 'done')
    await shutdown
    controller.abort(); otherController.abort(); await reader.return(); await otherReader.return()
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('an unanswered application consent does not block an unrelated native read', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-consent-read-'))
  const helper = join(root, 'native-helper.mjs')
  await writeFile(helper, await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url)), { mode: 0o700 })
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  const consent = Promise.withResolvers(), requested = Promise.withResolvers()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { requested.resolve(); return consent.promise } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper } }); await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'pending-consent', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `consent-${++seq}`, signal: new AbortController().signal })
    const app = call('getApp', { selector: 'Fixture' })
    await requested.promise
    const read = call('getCapabilities', {})
    const result = await Promise.race([read, delay(500).then(() => 'blocked')])
    assert.notEqual(result, 'blocked', 'unrelated read waited for the human consent')
    assert.equal(result.isError, false)
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] })
    assert.equal((await app).isError, false)
  } finally {
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
    await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true })
  }
})

test('pending consent for another app does not stop authorized previews', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-pending-consent-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8')).replace("      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))", "      if (params.selector === 'Second') return { ...app, appHandle: `${scope}-second`, name: 'Second', authorization: { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second', persistable: false } }\n      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  const consent = Promise.withResolvers(), requested = Promise.withResolvers()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { requested.resolve(); return consent.promise } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'pending-preview', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `pending-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    await reader.next()
    const selection = call('getApp', { selector: 'Second' }); await requested.promise
    let observed = []
    for (let i = 0; i < 400; i++) {
      observed = (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      if (observed.some(row => row.method === 'screenshot' && row.params.displayOnly)) break
      await delay(10)
    }
    assert.ok(observed.some(row => row.method === 'screenshot' && row.params.displayOnly), 'pending consent blocked the authorized preview')
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }); await selection
    controller.abort(); await reader.return()
  } finally {
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
    await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true })
  }
})

test('consent for a pending launch leaves other previews running and cancels them before launch', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-launch-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace("    input.on('line', line => {", "    const delayed = new Map()\n    input.on('line', line => {")
    .replace("      if (request.type === 'cancel') {", "      if (request.type === 'cancel') {\n        const timer = delayed.get(request.id)\n        if (timer) { clearTimeout(timer); delayed.delete(request.id); scopedRecord('slow-cancel', { id: request.id }); socket.write(JSON.stringify({ id: request.id, error: { code: 'NATIVE_CANCELLED', message: 'cancelled' } }) + '\\n') }")
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('slow-start', { id: request.id })\n        const timer = setTimeout(() => { delayed.delete(request.id); socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n') }, 250)\n        delayed.set(request.id, timer); return\n      }\n      let response\n      try {")
    .replace("      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))", "      if (params.selector === 'Pending') return { ...app, pid: null, appHandle: `${scope}-pending`, name: 'Pending', authorization: { id: 'b'.repeat(64), name: 'Pending', executablePath: '/fixture/pending', persistable: false } }\n      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))")
    .replace("    if (!acquired || params.appHandle !== app.appHandle)", "    if (method === 'launchApp') return { ...app, appHandle: params.appHandle, name: 'Pending' }\n    if (!acquired || params.appHandle !== app.appHandle)")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  const consent = Promise.withResolvers(), requested = Promise.withResolvers()
  const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { requested.resolve(); return consent.promise } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'launch-preview', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `launch-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    await reader.next()
    const selection = call('getApp', { selector: 'Pending' }); await requested.promise
    for (let i = 0; i < 400 && !(await events()).some(row => row.method === 'screenshot' && row.params.displayOnly); i++) await delay(10)
    let observed = await events()
    assert.ok(observed.some(row => row.method === 'screenshot' && row.params.displayOnly), 'consent blocked an authorized app preview')
    const starts = observed.filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= starts; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > starts)
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] })
    const result = await selection; assert.equal(result.isError, false, JSON.stringify(result))
    observed = await events()
    assert.ok(observed.some(row => row.event === 'slow-cancel'))
    assert.ok(observed.some(row => row.method === 'launchApp'))
    controller.abort(); await reader.return()
  } finally {
    consent.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
    await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true })
  }
})

test('a native read timing out in the request queue retains its native error code', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-queue-timeout-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('slow-start', { id: request.id })\n        setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 1500); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 500, graceMs: 2000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'queue-timeout', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `timeout-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    await reader.next()
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let i = 0; i < 300 && !(await events()).some(row => row.event === 'slow-start'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'slow-start'))
    const raw = ctx.tools.get('cua').execute({ method: 'getCapabilities', params: {} }, { agent, callId: `timeout-${++seq}`, signal: new AbortController().signal }).catch(error => error)
    const resultPromise = call('getCapabilities', {})
    assert.equal((await raw).code, 'NATIVE_TIMEOUT')
    const result = await resultPromise
    assert.equal(result.isError, true)
    assert.match(result.error.message, /^NATIVE_TIMEOUT:/)
    controller.abort(); await reader.return()
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('queued wait and native dispatch share one request timeout budget', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-queue-budget-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if ((request.method === 'listWindows' && request.params.displayOnly) || request.method === 'getCapabilities') {\n        scopedRecord('slow-start', { id: request.id, method: request.method })\n        setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), request.method === 'listWindows' ? 300 : 350); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 500, graceMs: 1000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
    await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'queue-budget', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const execute = (method, params) => ctx.tools.get('cua').execute({ method, params }, { agent, callId: `budget-${++seq}`, signal: new AbortController().signal })
    const app = await ctx.tools.execute({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Fixture' } }, agent, callId: `budget-${++seq}`, signal: new AbortController().signal })
    assert.equal(app.isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    await reader.next()
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let i = 0; i < 300 && !(await events()).some(row => row.event === 'slow-start' && row.method === 'listWindows'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'slow-start' && row.method === 'listWindows'))
    await assert.rejects(execute('getCapabilities', {}), error => error.code === 'NATIVE_TIMEOUT')
    assert.ok((await events()).some(row => row.event === 'slow-start' && row.method === 'getCapabilities'))
    controller.abort(); await reader.return()
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('revocation while a window request is queued prevents native dispatch', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-queued-revoke-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if (request.method === 'getCapabilities') {\n        scopedRecord('slow-start', { id: request.id })\n        setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 400); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    const config = { helperPath: helper, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] }
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'queued-revoke', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `revoke-${++seq}`, signal: new AbortController().signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false)
    const activeRead = call('getCapabilities', {})
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let i = 0; i < 100 && !(await events()).some(row => row.event === 'slow-start'); i++) await delay(5)
    assert.ok((await events()).some(row => row.event === 'slow-start'))
    const queued = call('getState', { appHandle: app.value.appHandle, windowId: 7 })
    await delay(10); await ctx.loader.update('perse-cua', { config: { ...config, allowedApps: [] } })
    assert.equal((await queued).isError, true)
    await activeRead
    assert.equal((await events()).some(row => row.method === 'getState'), false)
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('preview queue expiry keeps the last frame and retries after the connection is free', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-queue-frame-'))
  const helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if (existsSync(new URL('./slow-refresh', import.meta.url)) && request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('slow-list', { id: request.id }); setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 150); return\n      }\n      if (existsSync(new URL('./slow-refresh', import.meta.url)) && request.method === 'getCapabilities') {\n        scopedRecord('slow-read', { id: request.id }); setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 800); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 1500, screenshotTimeoutMs: 250, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } })
    await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'queue-frame', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `queue-frame-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = [], updates = []
    const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) { latest = items; updates.push(items) } })()
    for (let i = 0; i < 300 && !latest[0]?.image; i++) await delay(10)
    assert.ok(latest[0]?.image); const original = latest[0].image
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    const initialShots = (await events()).filter(row => row.method === 'screenshot').length
    await writeFile(join(root, 'slow-refresh'), '')
    for (let i = 0; i < 300 && !(await events()).some(row => row.event === 'slow-list'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'slow-list'))
    const read = call('getCapabilities', {})
    for (let i = 0; i < 100 && !(await events()).some(row => row.event === 'slow-read'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'slow-read'))
    await delay(400)
    assert.equal(latest[0].image, original)
    assert.notEqual(latest[0].previewUnavailable, true)
    assert.ok(updates.every(items => items.every(item => item.previewUnavailable !== true)))
    assert.equal((await events()).filter(row => row.method === 'screenshot').length, initialShots)
    assert.equal((await read).isError, false)
    await rm(join(root, 'slow-refresh'))
    for (let i = 0; i < 300 && (await events()).filter(row => row.method === 'screenshot').length === initialShots; i++) await delay(10)
    assert.ok((await events()).filter(row => row.method === 'screenshot').length > initialShots)
    assert.equal(latest[0].image, original)
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('application discovery access failures clear only its frames and recover without bypassing revocation', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-list-access-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace("      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))", "      if (params.selector === 'Second') return { ...app, appHandle: `${scope}-second`, name: 'Second', authorization: { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second', persistable: false } }\n      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))")
    .replace("    if (!acquired || params.appHandle !== app.appHandle)", "    if (!acquired || ![app.appHandle, `${scope}-second`].includes(params.appHandle))")
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly && existsSync(new URL('./list-error', import.meta.url)) && (request.params.appHandle.endsWith('-app') || ['PERMISSION_DENIED', 'NATIVE_CLOSED'].includes(readFileSync(new URL('./list-error', import.meta.url), 'utf8')))) {\n        socket.write(JSON.stringify({ id: request.id, error: { code: readFileSync(new URL('./list-error', import.meta.url), 'utf8'), message: 'fixture failure' } }) + '\\n'); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    const config = { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }, { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second' }] }
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'list-access', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `list-access-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    assert.equal((await call('getApp', { selector: 'Second' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    const first = () => latest.find(row => row.id.includes('fixture-app'))
    const second = () => latest.find(row => row.id.includes('fixture-second'))
    const until = async condition => { for (let i = 0; i < 800 && !condition(); i++) await delay(10); assert.ok(condition(), 'preview state did not arrive') }
    await until(() => first()?.image && second()?.image)
    for (const code of ['PERMISSION_DENIED', 'STALE_APP', 'NATIVE_CLOSED', 'NATIVE_TIMEOUT']) {
      const image = first().image; await writeFile(join(root, 'list-error'), code)
      await until(() => first()?.discoveryUnavailable)
      assert.equal(first().image, code === 'NATIVE_TIMEOUT' ? image : undefined, code)
      if (code !== 'NATIVE_TIMEOUT') assert.equal(first().capturedAt, undefined, code)
      if (code === 'NATIVE_CLOSED' || code === 'PERMISSION_DENIED') { await until(() => second()?.discoveryUnavailable); assert.equal(second().image, undefined) }
      else assert.ok(second()?.image, `other application lost its frame for ${code}`)
      await rm(join(root, 'list-error')); await until(() => first()?.image && !first().discoveryUnavailable && second()?.image && !second().discoveryUnavailable)
    }
    await ctx.loader.update('perse-cua', { config: { ...config, allowedApps: [] } }); await ctx.loader.await()
    await until(() => latest.length === 0)
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('denying an unselected app clears previews on the connection it invalidates', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-denied-new-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8')).replace("      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))", "      if (params.selector === 'Second') return { ...app, appHandle: `${scope}-second`, name: 'Second', authorization: { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second', persistable: false } }\n      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Deny'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'deny-new', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `deny-new-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    for (let i = 0; i < 500 && !latest[0]?.image; i++) await delay(10)
    assert.ok(latest[0]?.image)
    assert.equal((await call('getApp', { selector: 'Second' })).isError, true)
    for (let i = 0; i < 40 && latest.length; i++) await delay(5)
    assert.deepEqual(latest, [])
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})
