import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeNative } from '../packages/perse-cua/lib/types/native-preview.js'

test('native previews follow final outcomes, isolate windows and clear on disposal', () => {
  const listeners = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const windows = new Map()
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view)
  const agent = { id: 'a' }, other = { id: 'b' }
  const emit = (owner, method, params, value, isError = false) => listeners.get('tools/result')({ name: 'cua', agent: owner, arguments: { method, params } }, isError ? { isError: true } : { isError: false, value })
  const app = owner => emit(owner, 'getApp', {}, { appHandle: 'app', name: 'Editor' })
  app(agent); app(other)
  const state = id => ({ windowId: id, windows: [{ windowId: id, title: `Window ${id}`, isOnScreen: true }] })
  emit(agent, 'getState', { appHandle: 'app', windowId: 1 }, state(1))
  emit(agent, 'screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  emit(other, 'getState', { appHandle: 'app', windowId: 2 }, state(2))
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  assert.equal(windows.get('b/app/2').title, 'Editor · Window 2')
  emit(agent, 'click', { appHandle: 'app', windowId: 1 }, undefined, true)
  assert.equal(windows.get('a/app/1').image, undefined)
  assert.equal(windows.get('a/app/1').failed, true)
  assert.equal(windows.get('a/app/1').previewUnavailable, false)
  listeners.get('agent/disposed')({ agent })
  assert.equal(windows.has('a/app/1'), false)
  assert.equal(windows.has('b/app/2'), true)
  preview.close(); assert.equal(listeners.size, 0)
})

test('reselecting an application preserves existing and dismissed previews', () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  for (const windowId of [1, 2]) emit('getState', { appHandle: 'app', windowId }, { windowId, windows: [{ windowId, isOnScreen: true }] })
  view.dismiss('a/app/2'); view.remove('a/app/2')
  const original = windows.get('a/app/1')
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  assert.equal(windows.get('a/app/1'), original)
  assert.equal(windows.has('a/app/2'), false)
  preview.close()
})

test('a failed model screenshot refreshes the preview independently of the model request', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  let calls = 0
  preview.hooks.onClient(agent, async (_handle, windowId) => { calls++; return { windowId, data: 'YWJj', mimeType: 'image/png' } })
  const emit = (method, params, value, isError = false) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, isError ? { isError: true } : { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve))
  emit('screenshot', { appHandle: 'app', windowId: 1 }, undefined, true)
  assert.equal(windows.get('a/app/1').image, undefined)
  assert.equal(windows.get('a/app/1').failed, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  assert.equal(windows.get('a/app/1').previewUnavailable, false)
  assert.equal(windows.get('a/app/1').failed, true)
  preview.close()
})

test('preview cancels stale capture and never publishes it after disposal', async () => {
  const listeners = new Map(), windows = new Map(), pending = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  preview.hooks.onClient(agent, (_handle, id, signal) => new Promise((resolve, reject) => { pending.push({ id, signal, resolve, reject }) }))
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, title: 'One', isOnScreen: true }] })
  assert.equal(pending.length, 1)
  emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve({ windowId: 1, data: 'b2xk', mimeType: 'image/png' })
  pending[1].resolve({ windowId: 1, data: 'bmV3', mimeType: 'image/png' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,bmV3')
  emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
  listeners.get('agent/disposed')({ agent })
  assert.equal(pending[2].signal.aborted, true)
  pending[2].resolve({ windowId: 1, data: 'bGF0ZQ==', mimeType: 'image/png' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.size, 0)
  preview.close()
})

test('element actions follow the snapshot window after another window is observed', async () => {
  const listeners = new Map(), windows = new Map(), calls = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  preview.hooks.onClient(agent, async (_handle, windowId) => { calls.push(windowId); return { windowId, data: 'YWJj', mimeType: 'image/png' } })
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  for (const windowId of [1, 2]) {
    emit('getState', { appHandle: 'app', windowId }, { windowId, snapshotId: `snapshot-${windowId}`, windows: [1, 2].map(id => ({ windowId: id, title: `${id}`, isOnScreen: true })) })
    await new Promise(resolve => setImmediate(resolve))
  }
  emit('click', { appHandle: 'app', snapshotId: 'snapshot-1', elementIndex: 1 }, { dispatched: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [1, 2, 1])
  assert.equal(windows.get('a/app/1').action, 'click')
  preview.close()
})

test('a dismissed window can reappear on a later operation', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, title: 'One', isOnScreen: true }] })
  view.dismiss('a/app/1'); view.remove('a/app/1')
  emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').action, 'click')
  preview.close()
})

test('a denied preview capture clears an earlier image', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  let allowed = true
  preview.hooks.onClient(agent, async (_handle, windowId) => { if (!allowed) throw new Error('access revoked'); return { windowId, data: 'YWJj', mimeType: 'image/png' } })
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve)); assert.ok(windows.get('a/app/1').image)
  allowed = false
  emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('a/app/1').image, undefined)
  assert.equal(windows.get('a/app/1').previewUnavailable, true)
  preview.close()
})

test('revoking an application clears all windows on the invalidated connection', async () => {
  const listeners = new Map(), windows = new Map(), requests = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  preview.hooks.onClient(agent, (_handle, windowId, signal) => new Promise(resolve => requests.push({ windowId, signal, resolve })))
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  emit('getApp', {}, { appHandle: 'second', name: 'Second' })
  emit('getState', { appHandle: 'second', windowId: 2 }, { windowId: 2, windows: [{ windowId: 2, isOnScreen: true }] })
  preview.hooks.onRevoke(agent, 'app')
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests[1].signal.aborted, true)
  requests[1].resolve({ windowId: 2, data: 'YWJj', mimeType: 'image/png' })
  requests[0].resolve({ windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.size, 0)
  preview.close()
})

test('a capture cancelled for a new native operation retains the last frame', async () => {
  const listeners = new Map(), windows = new Map(), pending = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  preview.hooks.onClient(agent, (_handle, _window, signal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })))
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  pending[0].resolve({ windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  await new Promise(resolve => setImmediate(resolve))
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  assert.equal(pending[1].signal.aborted, false)
  pending[1].reject(Object.assign(new Error('superseded by another operation'), { code: 'NATIVE_CANCELLED' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  assert.equal(windows.get('a/app/1').previewUnavailable, false)
  preview.hooks.onRevoke(agent, 'app')
  assert.equal(windows.size, 0)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(pending.length, 2)
  preview.close()
})

test('a cancelled capture retries after operations settle and publishes the latest frame', async () => {
  const listeners = new Map(), windows = new Map(); let calls = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  preview.hooks.onClient(agent, async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('operation superseded capture'), { code: 'NATIVE_CANCELLED' })
    if (calls === 2) throw Object.assign(new Error('operation still active'), { code: 'NATIVE_BUSY' })
    return { windowId: 1, data: 'bmV3', mimeType: 'image/png' }
  })
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  for (let i = 0; i < 100 && !windows.get('a/app/1')?.image; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 3)
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,bmV3')
  preview.hooks.onRevoke(agent, 'app')
  assert.equal(windows.size, 0)
  preview.close()
})

test('click position appears only on the matching model screenshot', () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, snapshotId: 'snapshot', windows: [{ windowId: 1, isOnScreen: true }] })
  emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png', pixelWidth: 100, pixelHeight: 200 })
  emit('hover', { appHandle: 'app', windowId: 1, x: 25, y: 100 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').point, undefined)
  emit('click', { appHandle: 'app', windowId: 1, x: 25, y: 100 }, { dispatched: true })
  assert.deepEqual(windows.get('a/app/1').point, { x: 0.25, y: 0.5 })
  emit('click', { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 2 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').point, undefined)
  emit('click', { appHandle: 'app', windowId: 1, relative: true, x: 250, y: 500 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').point, undefined)
  preview.close()
})

test('click marker is omitted when the preview no longer matches the model image', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png', pixelWidth: 100, pixelHeight: 200 })
  preview.hooks.onClient(agent, async () => ({ windowId: 1, data: 'ZGlmZmVyZW50', mimeType: 'image/png' }))
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve))
  emit('click', { appHandle: 'app', windowId: 1, x: 25, y: 100 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').point, undefined)
  preview.close()
})

test('relative click marker requires a preview captured at the observed window size', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  preview.hooks.onClient(agent, async () => ({ windowId: 1, data: 'YWJj', mimeType: 'image/png', bounds: { width: 400, height: 300 } }))
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, bounds: { width: 400, height: 300 }, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve))
  emit('click', { appHandle: 'app', windowId: 1, relative: true, x: 250, y: 500 }, { dispatched: true })
  assert.deepEqual(windows.get('a/app/1').point, { x: 0.25, y: 0.5 })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, bounds: { width: 500, height: 300 }, isOnScreen: true }] })
  emit('click', { appHandle: 'app', windowId: 1, relative: true, x: 250, y: 500 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').point, undefined)
  preview.close()
})

test('subscribed native previews discover and refresh windows without model calls, and stop on dismissal and unsubscribe', async () => {
  const listeners = new Map(), windows = new Map(), calls = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  let generation = 0
  preview.hooks.onClient(agent, async (_handle, windowId) => { calls.push(windowId); return { windowId, data: Buffer.from(String(++generation)).toString('base64'), mimeType: 'image/png', bounds: { width: 100, height: 100 } } }, async () => [
    { windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true },
    { windowId: 2, title: 'Two', bounds: { width: 200, height: 100 }, isOnScreen: true, onCurrentSpace: true },
    { windowId: 3, title: 'Hidden', bounds: { width: 100, height: 100 }, isOnScreen: false, onCurrentSpace: true },
  ])
  listeners.get('tools/result')({ name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  for (let i = 0; i < 100 && calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(calls.slice(0, 3), [1, 2, 1])
  assert.equal(windows.size, 2)
  view.dismiss('auto/app/2'); view.remove('auto/app/2')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(windows.has('auto/app/2'), false)
  view.watch('auto', false)
  const count = calls.length
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(calls.length, count)
  preview.close()
})

test('revocation cancels an in-flight background capture and rejects its late frame', async () => {
  const listeners = new Map(), windows = new Map(); let pending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  preview.hooks.onClient(agent, (_handle, id, signal) => new Promise(resolve => { pending = { id, signal, resolve } }), async () => [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }])
  listeners.get('tools/result')({ name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(pending)
  preview.hooks.onRevoke(agent, 'app')
  assert.equal(pending.signal.aborted, true)
  pending.resolve({ windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(windows.size, 0)
  preview.close()
})

test('transient absence retains automatic cards, then removes only automatic cards after repeated absence', async () => {
  const listeners = new Map(), windows = new Map(); let rows = [], scans = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 30 }), agent = { id: 'auto' }
  const row = windowId => ({ windowId, title: `Window ${windowId}`, bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true })
  rows = [row(1), row(2)]
  preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'YWJj', mimeType: 'image/png' }), async () => { scans++; return rows })
  const emit = (method, params, value) => listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' }); view.watch('auto', true)
  while (scans < 2) await new Promise(resolve => setTimeout(resolve, 5))
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: rows })
  rows = []
  const base = scans
  while (scans < base + 2) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(windows.has('auto/app/2'))
  while (scans < base + 3) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(windows.has('auto/app/2'), false)
  assert.equal(windows.get('auto/app/1').windowUnavailable, true)
  preview.close()
})

test('old helpers reject display-only discovery visibly without falling back or retrying', async () => {
  const listeners = new Map(), windows = new Map(); let scans = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  preview.hooks.onClient(agent, async () => { throw new Error('unexpected capture') }, async () => { scans++; throw Object.assign(new Error('unknown parameter'), { code: 'INVALID_ARGUMENT' }) })
  listeners.get('tools/result')({ name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  for (let i = 0; i < 100 && !scans; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(scans, 1)
  assert.equal(windows.get('auto/app/status').previewUnavailable, true)
  preview.close()
})

test('background discovery never runs when application selection is denied', async () => {
  const listeners = new Map(); let scans = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put() { assert.fail('denied application produced a card') }, remove() {} }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  preview.hooks.onClient(agent, async () => { throw new Error('unexpected capture') }, async () => { scans++; return [] })
  listeners.get('tools/result')({ name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: true })
  view.watch('auto', true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(scans, 0)
  preview.close()
})

test('three discovered windows refresh after resize and content changes until dismissal or revocation', async () => {
  const listeners = new Map(), windows = new Map(), calls = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  const sizes = new Map([[1, [700, 400]], [2, [420, 420]], [3, [280, 570]]])
  let revision = 0
  const rows = () => [...sizes].map(([windowId, [width, height]]) => ({ windowId, title: `Window ${windowId}`, bounds: { width, height }, isOnScreen: true, onCurrentSpace: true }))
  preview.hooks.onClient(agent, async (_handle, windowId) => {
    const [width, height] = sizes.get(windowId)
    calls.push({ windowId, width, height, revision })
    return { windowId, data: Buffer.from(`${windowId}:${width}x${height}:${revision}`).toString('base64'), mimeType: 'image/png', bounds: { width, height } }
  }, async () => rows())
  listeners.get('tools/result')({ name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()) }
  await waitFor(() => windows.size === 3 && [...windows.values()].every(item => item.image))
  const before = windows.get('auto/app/1').image
  sizes.set(1, [900, 500]); revision++
  await waitFor(() => calls.some(call => call.windowId === 1 && call.width === 900 && call.height === 500 && call.revision === 1))
  assert.notEqual(windows.get('auto/app/1').image, before)
  await waitFor(() => calls.some(call => call.windowId === 2 && call.revision === 1) && calls.some(call => call.windowId === 3 && call.revision === 1))
  view.dismiss('auto/app/2'); view.remove('auto/app/2')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(windows.has('auto/app/2'), false)
  preview.hooks.onRevoke(agent, 'app')
  assert.equal(windows.size, 0)
  preview.close()
})

test('continuous refresh recovers visibility and superseded slow captures without further model calls', async () => {
  const listeners = new Map(), windows = new Map(), events = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item); events.push(['put', item.image, item.windowUnavailable]) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'continuous' }
  let visible = true, revision = 0, width = 300, slow, modelCalls = 0
  const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()) }
  preview.hooks.onClient(agent, async (_handle, windowId, signal) => {
    const value = `${revision}:${width}`
    events.push(['capture', value])
    if (revision === 2 && !slow) await new Promise(resolve => { slow = { signal, resolve } })
    return { windowId, data: Buffer.from(value).toString('base64'), mimeType: 'image/png', bounds: { width, height: 200 } }
  }, async () => visible ? [{ windowId: 1, title: 'Fixture', bounds: { width, height: 200 }, isOnScreen: true, onCurrentSpace: true }] : [])
  const emit = (method, params, value) => { modelCalls++; listeners.get('tools/result')({ name: 'cua', agent, arguments: { method, params } }, { isError: false, value }) }
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' }); view.watch(agent.id, true)
  const image = value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`
  await waitFor(() => windows.get('continuous/app/1')?.image === image('0:300'))
  revision = 1; width = 500
  await waitFor(() => windows.get('continuous/app/1')?.image === image('1:500'))
  visible = false
  await waitFor(() => !windows.has('continuous/app/1'))
  visible = true; revision = 2; width = 600
  await waitFor(() => !!slow)
  revision = 3; width = 700; slow.resolve()
  await waitFor(() => windows.get('continuous/app/1')?.image === image('3:700'))
  assert.equal(modelCalls, 1)
  assert.ok(events.some(event => event[0] === 'capture' && event[1] === '2:600'))
  assert.ok(events.some(event => event[0] === 'capture' && event[1] === '3:700'))
  preview.close()
})
