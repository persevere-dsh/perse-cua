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

test('macOS rejects MCP backend and driver settings before starting a provider', { skip: process.platform !== 'darwin' }, () => {
  const ctx = new Context()
  assert.throws(() => Main.apply(ctx, { backend: 'mcp' }), /requires the native backend/)
  assert.throws(() => Main.apply(ctx, { backend: 'mcp', command: '/fixture' }), /requires the native backend/)
  assert.throws(() => Main.apply(ctx, { command: '/fixture' }), /remove MCP driver settings/)
  assert.throws(() => Main.apply(ctx, { allow: ['click'] }), /remove MCP driver settings/)
  assert.throws(() => Main.apply(ctx, { backend: 'native', args: [] }), /cannot use MCP driver settings/)
  assert.throws(() => Main.apply(ctx, { backend: 'native', helperPath: '/nonexistent/perse-cua-helper' }), /unavailable or not executable/)
  ctx.provide('profileContext', {})
  assert.throws(() => Main.apply(ctx, { presenterOnly: true }), /use the perse-cua\/presenter entrypoint/)
  assert.throws(() => Main.apply(ctx, {}), /requires DSH profile tool admission version 1/)
  ctx.provide('profileToolAdmission', { version: 0 })
  assert.throws(() => Main.apply(ctx, {}), /requires DSH profile tool admission version 1/)
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

test('macOS native loader entry stops on disable', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = await host()
  try {
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: {} })
    await ctx.loader.await()
    await waitFor(() => ctx.computerUse?.providerName === 'dsh-cua' && ctx.tools.get('cua'))
    assert.equal(ctx.tools.get('mcp__cua__get_window_state'), undefined)
    const schema = ctx.tools.schemas().find(tool => tool.name === 'cua').parameters
    assert.deepEqual(schema.required, ['method', 'params'])
    assert.ok(schema.properties.method.enum.includes('saveScreenshot'))
    const removeSkillCatalog = ctx.systemPrompt.section({ name: 'fixture:skill-catalog', order: 0, text: 'Available skill: cua-driver (CLI or MCP). Load the skill for GUI tasks.' })
    const guidance = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(guidance, /use the registered cua tool and its application authorization flow/ )
    assert.match(guidance, /Available skill: cua-driver/ )
    assert.match(guidance, /Do not use external cua-driver CLI or MCP tools/ )
    assert.match(guidance, /If a required capability is unavailable, explain the limitation/ )
    assert.match(guidance, /Do not switch providers to bypass denied or revoked access/ )
    const removePtc = ctx.provide('ptcRuntime', { programFormat: 'repl' })
    const replGuidance = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(replGuidance, /vendor\/dsh-cua-bridge\.js/)
    assert.doesNotMatch(replGuidance, /@deepseek-ai\/dsh-cua\/bridge/)
    removePtc()
    const entry = ctx.loader.resolve('perse-cua'), fiber = entry.fiber
    const grants = fiber.config.allowedApps
    await ctx.loader.update('perse-cua', { config: { allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture' }] } })
    await ctx.loader.await()
    assert.equal(entry.fiber, fiber)
    assert.equal(grants.get()[0].name, 'Fixture')
    removeSkillCatalog()
    await ctx.loader.update('perse-cua', { disabled: true })
    await ctx.loader.await()
    assert.equal(ctx.tools.get('mcp__cua__get_window_state'), undefined)
    assert.equal(ctx.tools.get('cua'), undefined)
  } finally { await ctx.fiber.dispose() }
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
    await assert.rejects(tool.execute({ method: 'saveScreenshot', params: { appHandle: app.appHandle, windowId: 7 } }, execution(allowedAgent)), /ARTIFACT_UNAVAILABLE/)
    let bytes
    const ref = { mediaType: 'image/png', width: 1, height: 1 }
    ctx.provide('attachments', {
      async saveImages(images) { bytes = images[0].data; return [ref] },
      async readImage() { return { data: bytes, ref } },
      async saveFile({ data }) { return { bytes: data.length } },
      fileHostPath() { return '/fixture/screenshot.png' },
    })
    ctx.provide('fs', {
      processPathFromHostPath: value => value,
      resolve: async value => value,
      processPath: value => value,
      lstat: async () => ({ type: 'file' }),
      stat: async () => ({ type: 'file', size: bytes.length }),
      readBytes: async () => bytes,
    })
    const saved = await tool.execute({ method: 'saveScreenshot', params: { appHandle: app.appHandle, windowId: 7 } }, execution(allowedAgent))
    assert.equal(saved.path, '/fixture/screenshot.png')
    assert.equal(saved.modelReceivedImage, false)
    assert.equal(Object.hasOwn(saved, 'data'), false)
    assert.equal((await events()).some(event => event.method === 'getState'), true)
    await tool.execute({ method: 'getApp', params: { selector: 'Fixture', instance: 'new' } }, execution(allowedAgent))
    assert.equal((await events()).some(event => event.method === 'getApp' && event.params.instance === 'new'), true)
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
      ctx.provide('profileToolAdmission', { version: 1, stage() {} })
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
  const closeHost = await startFixtureHost(helper, { prestart: true }); const ctx = new Context()
  const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 2000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } })
    await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'read-test', ctx }, other = { id: 'other-read-test', ctx }
    ctx.agents.get = id => id === agent.id ? agent : id === other.id ? other : undefined
    let sequence = 0
    const call = (method, params = {}, owner = agent, signal = new AbortController().signal) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent: owner, callId: `read-${++sequence}`, signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false, `getApp failed: ${/^([A-Z][A-Z0-9_]*):/.exec(app.error?.message ?? '')?.[1] ?? 'UNCLASSIFIED'}`)
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
    await writeFile(join(root, 'slow-duration'), '5000')
    const beforeDeadline = (await events()).filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= beforeDeadline; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > beforeDeadline)
    const started = Date.now()
    assert.equal((await call('getCapabilities')).isError, false)
    assert.ok(Date.now() - started < 3400, 'passive read exceeded its configured wait and cleanup budget')
    const beforeRevoke = (await events()).filter(row => row.event === 'slow-start').length
    for (let i = 0; i < 300 && (await events()).filter(row => row.event === 'slow-start').length <= beforeRevoke; i++) await delay(10)
    assert.ok((await events()).filter(row => row.event === 'slow-start').length > beforeRevoke)
    const revokedRead = call('listApps').then(() => 'done', () => 'done')
    await delay(5)
    await ctx.loader.update('perse-cua', { config: { helperPath: helper, timeoutMs: 2000, previewRefreshIntervalMs: 1000, allowedApps: [] } })
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
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('slow-start', { id: request.id })\n        setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 3500); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 1500, graceMs: 3000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
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
    assert.equal((await events()).some(row => row.method === 'getCapabilities'), false, 'queue timeout dispatched the read')
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
    .replace('      let response\n      try {', "      if ((request.method === 'listWindows' && request.params.displayOnly) || request.method === 'getCapabilities') {\n        scopedRecord('slow-start', { id: request.id, method: request.method })\n        setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), request.method === 'listWindows' ? 1100 : 1100); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, timeoutMs: 1500, graceMs: 2000, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await()
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
      await rm(join(root, 'list-error'))
      if (code === 'PERMISSION_DENIED') assert.equal((await call('getCapabilities', {})).isError, false)
      await until(() => first()?.image && !first().discoveryUnavailable && second()?.image && !second().discoveryUnavailable)
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

test('revoking another agent does not cancel an authorized preview in flight', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-other-revoke-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace("    input.on('line', line => {", "    const delayed = new Map()\n    input.on('line', line => {")
    .replace("      if (request.type === 'cancel') {", "      if (request.type === 'cancel') {\n        const timer = delayed.get(request.id); if (timer) { clearTimeout(timer); delayed.delete(request.id); scopedRecord('preview-cancelled', { id: request.id }); socket.write(JSON.stringify({ id: request.id, error: { code: 'NATIVE_CANCELLED', message: 'cancelled' } }) + '\\n') }")
    .replace('      let response\n      try {', "      if (connectionId === 2 && request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('preview-start', { id: request.id }); const timer = setTimeout(() => { delayed.delete(request.id); socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n') }, 600); delayed.set(request.id, timer); return\n      }\n      let response\n      try {")
    .replace("      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))", "      if (params.selector === 'Second') { acquired = true; return { ...app, appHandle: `${scope}-second`, name: 'Second', authorization: { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second', persistable: true } } }\n      if (!['Fixture', 'test.fixture', '9'].includes(params.selector))")
    .replace("    if (!acquired || params.appHandle !== app.appHandle)", "    if (!acquired || ![app.appHandle, `${scope}-second`].includes(params.appHandle))")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    const a = { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }, b = { id: 'b'.repeat(64), name: 'Second', executablePath: '/fixture/second' }
    const config = { helperPath: helper, previewRefreshIntervalMs: 1000, timeoutMs: 3000, allowedApps: [a, b] }
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agentA = { id: 'other-a', ctx }, agentB = { id: 'other-b', ctx }; ctx.agents.get = id => id === agentA.id ? agentA : id === agentB.id ? agentB : undefined
    let seq = 0
    const call = (agent, method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `other-revoke-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call(agentA, 'getApp', { selector: 'Fixture' })).isError, false)
    assert.equal((await call(agentB, 'getApp', { selector: 'Second' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agentB.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let i = 0; i < 300 && !(await events()).some(row => row.event === 'preview-start'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'preview-start'))
    await ctx.loader.update('perse-cua', { config: { ...config, allowedApps: [b] } }); await ctx.loader.await()
    await delay(700)
    assert.equal((await events()).some(row => row.event === 'preview-cancelled'), false, 'revoking agent A interrupted agent B')
    for (let i = 0; i < 500 && !latest.some(row => row.image); i++) await delay(10)
    assert.ok(latest.some(row => row.image))
    for (let i = 0; i < 500 && (await events()).filter(row => row.method === 'screenshot' && row.connection === 2).length < 2; i++) await delay(10)
    const screenshots = (await events()).filter(row => row.method === 'screenshot' && row.connection === 2)
    assert.ok(screenshots.length >= 2, 'agent B did not continue refreshing')
    assert.ok(new Set(screenshots.map(row => row.params.windowId)).size >= 2, 'agent B did not refresh both windows')
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('same connection read does not hide an in-flight discovery permission failure', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-same-client-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && request.params.displayOnly && existsSync(new URL('./deny-list', import.meta.url))) {\n        scopedRecord('denied-list-start', { id: request.id }); setTimeout(() => socket.write(JSON.stringify({ id: request.id, error: { code: 'PERMISSION_DENIED', message: 'fixture permission denial' } }) + '\\n'), 400); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'same-client', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `same-client-${++seq}`, signal: new AbortController().signal })
    assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    for (let i = 0; i < 600 && !latest.some(row => row.image); i++) await delay(10)
    assert.ok(latest.some(row => row.image))
    await writeFile(join(root, 'deny-list'), '')
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let i = 0; i < 400 && !(await events()).some(row => row.event === 'denied-list-start'); i++) await delay(10)
    assert.ok((await events()).some(row => row.event === 'denied-list-start'))
    const read = call('getCapabilities', {})
    assert.equal((await read).isError, false)
    for (let i = 0; i < 100 && !latest.some(row => row.discoveryUnavailable); i++) await delay(10)
    assert.ok(latest.some(row => row.discoveryUnavailable), 'same connection permission failure was discarded')
    assert.ok(latest.every(row => !row.image), 'permission denial did not clear the frame')
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('repeated model window listing shares turns with automatic preview', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-list-fair-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace("    input.on('line', line => {", "    const delayed = new Map()\n    input.on('line', line => {")
    .replace("      if (request.type === 'cancel') {", "      if (request.type === 'cancel') {\n        const timer = delayed.get(request.id); if (timer) { clearTimeout(timer); delayed.delete(request.id); scopedRecord('audit-cancel', { id: request.id }); setTimeout(() => { scopedRecord('audit-cancel-ack', { id: request.id }); socket.write(JSON.stringify({ id: request.id, error: { code: 'NATIVE_CANCELLED', message: 'cancelled' } }) + '\\n') }, 150) }")
    .replace('      let response\n      try {', "      if (request.method === 'listWindows' && !request.params.displayOnly && existsSync(new URL('./deny-model', import.meta.url))) {\n        socket.write(JSON.stringify({ id: request.id, error: { code: 'PERMISSION_DENIED', message: 'fixture denied' } }) + '\\n'); return\n      }\n      if (request.method === 'listWindows' && request.params.displayOnly) {\n        scopedRecord('audit-start', { id: request.id }); const timer = setTimeout(() => { delayed.delete(request.id); socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n') }, 300); delayed.set(request.id, timer); return\n      }\n      let response\n      try {")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'list-fair', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `list-fair-${++seq}`, signal: new AbortController().signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i < 400 && (await events()).filter(event => event.event === 'audit-start').length < n; i++) await delay(10)
      assert.ok((await events()).filter(event => event.event === 'audit-start').length >= n)
      assert.equal((await call('listWindows', { appHandle: app.value.appHandle })).isError, false)
      if (n === 4) assert.ok((await events()).some(event => event.method === 'screenshot' && event.params.displayOnly), 'preview did not progress during reads')
    }
    for (let i = 0; i < 300 && !latest.some(row => row.image); i++) await delay(10)
    const observed = await events()
    assert.equal(observed.filter(event => event.event === 'audit-cancel').length, 0)
    assert.ok(observed.some(event => event.method === 'screenshot' && event.params.displayOnly))
    assert.ok(latest.some(row => row.image))
    const starts = observed.filter(event => event.event === 'audit-start').length
    for (let i = 0; i < 400 && (await events()).filter(event => event.event === 'audit-start').length <= starts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'audit-start').length > starts)
    const input = call('pressKey', { appHandle: app.value.appHandle, key: 'Return' })
    for (let i = 0; i < 100 && !(await events()).some(event => event.event === 'audit-cancel'); i++) await delay(5)
    assert.ok((await events()).some(event => event.event === 'audit-cancel'))
    assert.equal((await events()).some(event => event.method === 'pressKey'), false)
    assert.equal((await input).isError, false)
    const afterInput = await events()
    assert.ok(afterInput.findIndex(event => event.event === 'audit-cancel-ack') < afterInput.findIndex(event => event.method === 'pressKey'))
    await writeFile(join(root, 'deny-model'), '')
    const denied = await call('listWindows', { appHandle: app.value.appHandle })
    assert.equal(denied.isError, true); assert.match(denied.error.message, /^PERMISSION_DENIED:/)
    for (let i = 0; i < 100 && !latest.some(row => row.discoveryUnavailable); i++) await delay(10)
    assert.ok(latest.some(row => row.discoveryUnavailable)); assert.ok(latest.every(row => !row.image))
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('queued relative input uses the latest observed bounds before native dispatch', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-queued-coordinates-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('      let response\n      try {', "      if ((request.method === 'getState' || request.method === 'listWindows' && !request.params.displayOnly) && existsSync(new URL('./resize-window', import.meta.url))) {\n        scopedRecord('resize-state-start', { id: request.id, method: request.method }); setTimeout(() => socket.write(JSON.stringify({ id: request.id, result: call(request.id, request.method, request.params) }) + '\\n'), 400); return\n      }\n      let response\n      try {")
    .replace("    if (method === 'getCapabilities')", "    if ((method === 'getState' || method === 'listWindows') && existsSync(new URL('./resize-window', import.meta.url))) bounds.width = Number(readFileSync(new URL('./resize-window', import.meta.url), 'utf8'))\n    if (method === 'getCapabilities')")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    let holdImage = false
    const imageEntered = Promise.withResolvers(), releaseImage = Promise.withResolvers()
    ctx.provide('attachments', { async saveImages() { return [{ width: 1, height: 1 }] }, async readImageRequest() { if (holdImage) { imageEntered.resolve(); await releaseImage.promise }; return { data: Buffer.from([0]), width: 1, height: 1, mediaType: 'image/png' } } })
    ctx.provide('llm', { async resolveModelInfo() { return { inputModalities: ['image'] } }, imageRequestTarget() { return {} } })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'queued-coordinate', ctx, options: { provider: 'fixture', model: 'fixture' }, session: { requestHeader() { return undefined } } }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let seq = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `queued-coordinate-${++seq}`, signal: new AbortController().signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false)
    const handle = app.value.appHandle
    assert.equal((await call('getState', { appHandle: handle, windowId: 7 })).isError, false)
    await writeFile(join(root, 'resize-window'), '640')
    const events = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    const refresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && !(await events()).some(event => event.event === 'resize-state-start'); i++) await delay(10)
    assert.ok((await events()).some(event => event.event === 'resize-state-start'))
    const click = call('click', { appHandle: handle, windowId: 7, x: 500, y: 500, relative: true })
    assert.equal((await refresh).isError, false)
    const outcome = await click; assert.equal(outcome.isError, false)
    const nativeClick = (await events()).find(event => event.method === 'click')
    assert.equal(nativeClick?.params.x, 320, 'queued relative x was not recalculated for the resized window')
    await writeFile(join(root, 'resize-window'), '800')
    const listStarts = (await events()).filter(event => event.event === 'resize-state-start').length
    const inventory = call('listWindows', { appHandle: handle })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= listStarts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > listStarts)
    const listClick = call('click', { appHandle: handle, windowId: 7, x: 500, y: 500, relative: true })
    assert.equal((await inventory).isError, false); assert.equal((await listClick).isError, false)
    assert.equal((await events()).filter(event => event.method === 'click')[1]?.params.x, 400)
    const raw = (method, params) => ctx.tools.get('cua').execute({ method, params }, { agent, callId: `queued-coordinate-${++seq}`, signal: new AbortController().signal })
    assert.ok((await raw('screenshot', { appHandle: handle, windowId: 7 })).data)
    await writeFile(join(root, 'resize-window'), '960')
    const starts = (await events()).filter(event => event.event === 'resize-state-start').length
    const nextRefresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= starts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > starts)
    const stale = raw('click', { appHandle: handle, windowId: 7, x: 0, y: 0 }).catch(error => error)
    assert.equal((await nextRefresh).isError, false)
    assert.equal((await stale).code, 'SCREENSHOT_REQUIRED')
    assert.equal((await events()).filter(event => event.method === 'click').length, 2)
    assert.ok((await raw('screenshot', { appHandle: handle, windowId: 7 })).data)
    const sameStarts = (await events()).filter(event => event.event === 'resize-state-start').length
    const sameRefresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= sameStarts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > sameStarts)
    const sameClick = raw('click', { appHandle: handle, windowId: 7, x: 0, y: 0 })
    assert.equal((await sameRefresh).isError, false)
    assert.equal((await sameClick).dispatched, true)
    assert.equal((await events()).filter(event => event.method === 'click').length, 3)
    holdImage = true
    const newerScreenshot = raw('screenshot', { appHandle: handle, windowId: 7 })
    await imageEntered.promise
    const gateStarts = (await events()).filter(event => event.event === 'resize-state-start').length
    const gateRefresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= gateStarts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > gateStarts)
    const superseded = raw('click', { appHandle: handle, windowId: 7, x: 0, y: 0 }).catch(error => error)
    releaseImage.resolve(); await newerScreenshot
    assert.equal((await gateRefresh).isError, false)
    assert.equal((await superseded).code, 'SCREENSHOT_REQUIRED')
    assert.equal((await events()).filter(event => event.method === 'click').length, 3)
    const cancelledStarts = (await events()).filter(event => event.event === 'resize-state-start').length
    const cancelRefresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= cancelledStarts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > cancelledStarts)
    const cancelSignal = new AbortController()
    const cancelled = ctx.tools.get('cua').execute({ method: 'click', params: { appHandle: handle, windowId: 7, x: 500, y: 500, relative: true } }, { agent, callId: `queued-coordinate-${++seq}`, signal: cancelSignal.signal }).catch(error => error)
    await delay(10); cancelSignal.abort()
    assert.ok((await cancelled) instanceof Error); assert.equal((await cancelRefresh).isError, false)
    assert.equal((await events()).filter(event => event.method === 'click').length, 3)
    const revokeStarts = (await events()).filter(event => event.event === 'resize-state-start').length
    const revokeRefresh = call('getState', { appHandle: handle, windowId: 7 })
    for (let i = 0; i < 200 && (await events()).filter(event => event.event === 'resize-state-start').length <= revokeStarts; i++) await delay(10)
    assert.ok((await events()).filter(event => event.event === 'resize-state-start').length > revokeStarts)
    const revoked = raw('click', { appHandle: handle, windowId: 7, x: 500, y: 500, relative: true }).catch(error => error)
    await delay(10)
    await ctx.loader.update('perse-cua', { config: { helperPath: helper, allowedApps: [] } })
    assert.ok((await revoked) instanceof Error); await revokeRefresh
    assert.equal((await events()).filter(event => event.method === 'click').length, 3)
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('automatic provider previews refresh both windows while enumeration order changes', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-window-rotation-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace('  const snapshots = new Map()', '  let displayOrder = 0\n  const snapshots = new Map()')
    .replace("    if (method === 'listWindows') return [window, axlessWindow]", "    if (method === 'listWindows') return params.displayOnly && ++displayOrder % 2 === 0 ? [axlessWindow, window] : [window, axlessWindow]")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'rotation', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    const result = await ctx.tools.execute({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Fixture' } }, agent, callId: 'rotation-app', signal: new AbortController().signal })
    assert.equal(result.isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    const shots = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(event => event.method === 'screenshot' && event.params.displayOnly).map(event => event.params.windowId)
    for (let i = 0; i < 900 && (await shots()).length < 4; i++) await delay(10)
    const first = (await shots()).slice(0, 4)
    assert.equal(first.length, 4); assert.notEqual(first[0], first[1])
    assert.equal(first[0], first[2]); assert.equal(first[1], first[3])
    assert.deepEqual(new Set(first), new Set([7, 8]))
    assert.equal(latest.filter(item => item.image).length, 2)
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('automatically removed window IDs can be reused at a different size', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-preview-id-reuse-')), helper = join(root, 'native-helper.mjs')
  const source = (await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url), 'utf8'))
    .replace("    if (method === 'listWindows') return [window, axlessWindow]", "    if (method === 'listWindows' && params.displayOnly) { const state = JSON.parse(readFileSync(new URL('./window-state.json', import.meta.url), 'utf8')); bounds.width = state.width; return state.visible ? [{ ...window, title: state.title }] : [] }\n    if (method === 'listWindows') return [window, axlessWindow]")
  await writeFile(helper, source, { mode: 0o700 }); await writeFile(join(root, 'observe-helper'), '')
  const setWindow = state => writeFile(join(root, 'window-state.json'), JSON.stringify(state))
  await setWindow({ visible: true, width: 320, title: 'Original' })
  const closeHost = await startFixtureHost(helper), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, previewRefreshIntervalMs: 1000, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } }); await ctx.loader.await(); await waitFor(() => ctx.tools.get('cua'))
    const agent = { id: 'reuse', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    const app = await ctx.tools.execute({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Fixture' } }, agent, callId: 'reuse-app', signal: new AbortController().signal }); assert.equal(app.isError, false)
    const controller = new AbortController(), reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
    let latest = []; const consume = (async () => { for await (const items of { [Symbol.asyncIterator]: () => reader }) latest = items })()
    const until = async check => { for (let i = 0; i < 700 && !check(); i++) await delay(10); assert.ok(check(), 'expected preview state did not arrive') }
    await until(() => latest.some(item => item.title.endsWith('Original') && item.image))
    const id = latest[0].id
    await setWindow({ visible: false, width: 320, title: 'Original' }); await until(() => latest.length === 0)
    await setWindow({ visible: true, width: 640, title: 'Replacement' })
    await until(() => latest.some(item => item.id === id && item.title.endsWith('Replacement') && item.image && !item.previewUnavailable))
    assert.equal(latest[0].windowUnavailable, false)
    controller.abort(); await reader.return(); await consume
  } finally { await ctx.fiber.dispose(); await closeHost(); await rm(root, { recursive: true, force: true }) }
})

test('slow preview subscriber receives the click frame before the newer capture', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perse-click-stream-')), helper = join(root, 'native-helper.mjs')
  await writeFile(helper, await readFile(new URL('./fixtures/native-helper.mjs', import.meta.url)), { mode: 0o700 })
  await writeFile(join(root, 'observe-helper'), '')
  const closeHost = await startFixtureHost(helper, { prestart: true }), ctx = new Context()
  try {
    for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
    ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
    ctx.loader.builtins.perse = Main
    await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: { helperPath: helper, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } })
    await ctx.loader.await()
    const agent = { id: 'click-stream', ctx }; ctx.agents.get = id => id === agent.id ? agent : undefined
    let sequence = 0
    const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `click-stream-${++sequence}`, signal: new AbortController().signal })
    const app = await call('getApp', { selector: 'Fixture' }); assert.equal(app.isError, false)
    const handle = app.value.appHandle
    assert.equal((await call('getState', { appHandle: handle, windowId: 7 })).isError, false)
    const view = ctx.get('perseCuaView'), reader = view.watch(agent.id, new AbortController().signal)[Symbol.asyncIterator]()
    let initial
    while (!initial?.image) initial = (await reader.next()).value.find(item => item.id.endsWith('/7'))
    let pointPublished = false, capturePublished = false
    const put = view.put.bind(view)
    view.put = (item, freshPoint) => { if (item.point) pointPublished = true; else if (pointPublished && item.image) capturePublished = true; put(item, freshPoint) }
    assert.equal((await call('click', { appHandle: handle, windowId: 7, x: 250, y: 500, relative: true })).isError, false)
    for (let i = 0; i < 100 && !capturePublished; i++) await delay(5)
    assert.equal(pointPublished, true); assert.equal(capturePublished, true)
    assert.deepEqual((await reader.next()).value.find(item => item.id.endsWith('/7')).point, { x: 0.25, y: 0.5 })
    assert.equal((await reader.next()).value.find(item => item.id.endsWith('/7')).point, undefined)
    assert.equal((await call('click', { appHandle: handle, windowId: 7, x: 250, y: 500, relative: true })).isError, false)
    await ctx.emit('tools/result', { signal: new AbortController().signal, name: 'cua', agent, arguments: { method: 'listWindows', params: { appHandle: handle } } },
      { isError: false, value: [{ windowId: 7, title: 'Fixture', isOnScreen: false, bounds: { x: 10, y: 20, width: 400, height: 300 } }] })
    const hidden = (await reader.next()).value.find(item => item.id.endsWith('/7'))
    assert.equal(hidden.windowUnavailable, true); assert.equal(hidden.point, undefined)
    await reader.return()
  } finally { await ctx.fiber.dispose(); await closeHost() }
})
