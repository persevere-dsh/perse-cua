import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../packages/perse-cua/lib/index.js'

test('target windows keep distinct frames and screenshots retain the action session', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-baseline-'))
  const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__move_cursor'); i++) await pause(10)
  assert.ok(tools.has('mcp__cua__move_cursor'))
  const agent = { id: 'agent' }
  const action = tools.get('mcp__cua__move_cursor')
  await action.execute({ session: 'own', target: { kind: 'window', pid: 12, window_id: 7 }, x: 10, y: 10 }, { agent })
  await action.execute({ session: 'own', target: { kind: 'window', pid: 12, window_id: 8 }, x: 20, y: 20 }, { agent })
  let calls = []
  for (let i = 0; i < 100; i++) { calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); if (calls.filter(x => x.name === 'get_window_state').length === 2) break; await pause(10) }
  assert.deepEqual(calls.filter(x => x.name === 'get_window_state').map(x => [x.args.session, x.args.window_id]), [['own',7], ['own',8]])
  assert.ok(calls.findIndex(x => x.name === 'set_agent_cursor_enabled' && x.args.session === 'own') < calls.findIndex(x => x.name === 'move_cursor'))
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  let windows
  for (let i = 0; i < 100; i++) { windows = (await reader.next()).value; if (windows.length === 2 && windows.every(x => x.image)) break }
  assert.equal(windows.length, 2)
  assert.match(windows.find(x => x.id.endsWith('/7')).image, /AAAA$/)
  assert.match(windows.find(x => x.id.endsWith('/8')).image, /BBBB$/)
  await reader.return()
})


test('model reads and token actions get display-only full-size captures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-snapshot-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__click'); i++) await pause(10)
  const agent = { id: 'agent' }; const exec = { agent }
  await tools.get('mcp__cua__get_window_state').execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  await tools.get('mcp__cua__click').execute({ session: 'one', element_token: 's7:1' }, exec)
  let shots = []
  for (let i = 0; i < 100; i++) { shots = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.name === 'get_window_state' && x.args.display_only); if (shots.length === 2) break; await pause(10) }
  assert.equal(shots.length, 2)
  for (const shot of shots) { assert.equal(shot.args.session, 'one'); assert.equal(shot.args.window_id, 7); assert.equal(shot.args.max_image_dimension, 0); assert.equal(shot.args.include_accessibility_tree, false) }
})


test('presenter-only exposes the view without starting or registering driver tools', async () => {
  const ctx = new Context(); const names = []
  ctx.provide('tools', { register(tool) { names.push(tool.name); return () => {} } })
  const dispose = apply(ctx, { presenterOnly: true, command: '/nonexistent/perse-cua-driver' })
  const view = ctx.get('perseCuaView')
  assert.ok(view)
  view.put({ id: 'other/1', title: 'Other', action: 'read' })
  const stream = view.watch(new AbortController().signal)[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value[0].title, 'Other')
  assert.deepEqual(names, [])
  dispose()
  assert.equal((await stream.next()).done, true)
})


test('preview reports an in-flight action and clears it when the driver responds', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-working-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__move_cursor'); i++) await pause(10)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await reader.next()
  const pending = tools.get('mcp__cua__move_cursor').execute({ session: 'one', target: { kind: 'window', pid: 12, window_id: 7 }, delay: 80 }, { agent: { id: 'agent' } })
  const active = (await reader.next()).value
  assert.equal(active[0].working, true)
  await pending
  const done = (await reader.next()).value
  assert.equal(done[0].working, undefined)
  await reader.return()
})


test('a failed preview capture is visible and does not claim a new image', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-failure-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__move_cursor'); i++) await pause(10)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await reader.next()
  await tools.get('mcp__cua__move_cursor').execute({ target: { kind: 'window', pid: 12, window_id: 9 } }, { agent: { id: 'agent' } })
  let item
  for (let i = 0; i < 5; i++) { item = (await reader.next()).value[0]; if (item?.previewUnavailable) break }
  assert.equal(item.previewUnavailable, true)
  assert.equal(item.image, undefined)
  await reader.return()
})


test('a click point is tied to an accepted capture of the same window and session', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-point-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__click'); i++) await pause(10)
  const exec = { agent: { id: 'agent' } }; const read = tools.get('mcp__cua__get_window_state'); const click = tools.get('mcp__cua__click')
  const result = await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  assert.match(result.blocks.find(x => x.type === 'text' && x.text.startsWith('Screenshot coordinates:')).text, /"capture_id":"c7"/)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  let ready = (await reader.next()).value
  while (!ready.find(x => x.id.endsWith('/7'))?.image) ready = (await reader.next()).value
  await click.execute({ target: { kind: 'window', pid: 12, window_id: 7 }, session: 'one', capture_id: 'c7', x: 25, y: 10 }, exec)
  let current = (await reader.next()).value.find(x => x.id.endsWith('/7'))
  assert.deepEqual(current.point, { x: .25, y: .2 })
  assert.match(current.image, /AAAA$/)
  await reader.return()
  await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  const unmatched = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await unmatched.next()
  await click.execute({ target: { kind: 'window', pid: 12, window_id: 8 }, session: 'one', capture_id: 'c7', x: 25, y: 10 }, exec)
  current = (await unmatched.next()).value.find(x => x.id.endsWith('/8'))
  assert.equal(current.point, undefined)
  await unmatched.return()
})


test('a refused click or another session cannot produce an action point', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-unmatched-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__click'); i++) await pause(10)
  const exec = { agent: { id: 'agent' } }; const read = tools.get('mcp__cua__get_window_state'); const click = tools.get('mcp__cua__click')
  await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  const watch = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await watch.next()
  await assert.rejects(click.execute({ target: { kind: 'window', pid: 12, window_id: 7 }, session: 'one', capture_id: 'c7', x: 25, y: 10, refuse: true }, exec))
  const refused = (await watch.next()).value.find(x => x.id.includes('/one/'))
  assert.equal(refused.failed, true); assert.equal(refused.point, undefined)
  await watch.return()
  await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  const other = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await other.next()
  await click.execute({ target: { kind: 'window', pid: 12, window_id: 7 }, session: 'two', capture_id: 'c7', x: 25, y: 10 }, exec)
  const foreign = (await other.next()).value.find(x => x.id.includes('/two/'))
  assert.equal(foreign.point, undefined)
  await other.return()
})

test('a failed follow-up capture removes an action point', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-point-failure-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__click'); i++) await pause(10)
  const exec = { agent: { id: 'agent' } }
  await tools.get('mcp__cua__get_window_state').execute({ pid: 12, window_id: 9, session: 'one' }, exec)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await reader.next()
  await tools.get('mcp__cua__click').execute({ target: { kind: 'window', pid: 12, window_id: 9 }, session: 'one', capture_id: 'c9', x: 25, y: 10 }, exec)
  let item
  for (let i = 0; i < 5; i++) { item = (await reader.next()).value[0]; if (item?.previewUnavailable) break }
  assert.equal(item.previewUnavailable, true)
  assert.equal(item.point, undefined)
  assert.equal(item.image, undefined)
  await reader.return()
})

test('presenter entry cannot start a driver when passed ordinary plugin configuration', async () => {
  const { apply: present } = await import('../packages/perse-cua/lib/types/presenter.js')
  const ctx = new Context(); const names = []
  ctx.provide('tools', { register(tool) { names.push(tool.name); return () => {} } })
  const dispose = present(ctx, { presenterOnly: false, command: '/nonexistent/perse-cua-driver' })
  assert.ok(ctx.get('perseCuaView'))
  assert.deepEqual(names, [])
  dispose()
})

test('disposing a Cordis plugin terminates its own driver and unregisters tools', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-dispose-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const plugin = ctx.plugin({ name: 'perse-cua-lifecycle-test', inject: ['tools'], apply }, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  let pid
  t.after(async () => { await plugin.dispose(); if (pid) { try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } } rmSync(dir, { recursive: true, force: true }) })
  await plugin.await()
  for (let i = 0; i < 100 && !tools.has('mcp__cua__click'); i++) await pause(10)
  assert.ok(tools.has('mcp__cua__click'))
  pid = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.pid).pid
  await plugin.dispose()
  assert.equal(tools.size, 0)
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error } await pause(10) }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(tools.size, 0)
})

test('disposing the presenter plugin closes its preview stream', async () => {
  const { apply: present } = await import('../packages/perse-cua/lib/presenter.js')
  const ctx = new Context()
  const plugin = ctx.plugin({ name: 'presenter-lifecycle-test', apply: present })
  await plugin.await()
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  await reader.next()
  await plugin.dispose()
  assert.equal((await reader.next()).done, true)
})

test('a read of a closed window reports failure and retains its last frame', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-window-closed-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__get_window_state'); i++) await pause(10)
  const read = tools.get('mcp__cua__get_window_state'); const exec = { agent: { id: 'agent' } }
  await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  let initial = (await reader.next()).value[0]
  while (!initial?.image) initial = (await reader.next()).value[0]
  assert.match(initial.image, /AAAA$/)
  await assert.rejects(read.execute({ pid: 12, window_id: 7, session: 'one', missing: true }, exec))
  let failed
  for (let i = 0; i < 3; i++) { failed = (await reader.next()).value[0]; if (failed?.failed) break }
  assert.equal(failed.failed, true)
  assert.match(failed.image, /AAAA$/)
  assert.equal(failed.point, undefined)
  await reader.return()
})

test('off-screen enumeration keeps the last frame and time without inventing an action point', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-offscreen-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__get_window_state'); i++) await pause(10)
  const read = tools.get('mcp__cua__get_window_state'); const exec = { agent: { id: 'agent' } }
  await read.execute({ pid: 12, window_id: 7, session: 'one' }, exec)
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  let initial = (await reader.next()).value[0]
  while (!initial?.image) initial = (await reader.next()).value[0]
  await read.execute({ pid: 12, window_id: 7, session: 'one', offscreen: true }, exec)
  let hidden
  for (let i = 0; i < 5; i++) { hidden = (await reader.next()).value[0]; if (hidden?.windowUnavailable) break }
  assert.equal(hidden.windowUnavailable, true)
  assert.equal(hidden.image, initial.image)
  assert.equal(hidden.capturedAt, initial.capturedAt)
  assert.equal(hidden.point, undefined)
  await reader.return()
})

test('an empty accessibility tree does not imply an on-screen window is unavailable', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-empty-tree-')); const log = join(dir, 'calls')
  const ctx = new Context(); const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const dispose = apply(ctx, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/view-driver.mjs', import.meta.url)), log], indicator: false })
  t.after(() => { dispose(); rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100 && !tools.has('mcp__cua__get_window_state'); i++) await pause(10)
  await tools.get('mcp__cua__get_window_state').execute({ pid: 12, window_id: 7, session: 'one', emptytree: true }, { agent: { id: 'agent' } })
  const reader = ctx.get('perseCuaView').watch(new AbortController().signal)[Symbol.asyncIterator]()
  let item = (await reader.next()).value[0]
  while (!item?.image) item = (await reader.next()).value[0]
  assert.equal(item.windowUnavailable, undefined)
  assert.equal(item.previewUnavailable, undefined)
  await reader.return()
})
