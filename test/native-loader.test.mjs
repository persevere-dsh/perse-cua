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
