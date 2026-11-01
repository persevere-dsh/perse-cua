import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeNative } from '../packages/perse-cua/lib/types/native-preview.js'

const testSignal = new AbortController().signal

test('turn end stops pending capture and resumes only when the next turn uses CUA', async () => {
  const listeners = new Map(), windows = new Map(), pending = []
  let lists = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }, session = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  const event = (type, data) => listeners.get('session/event')(session, { type, data })
  preview.hooks.onClient(agent, (_handle, id, signal) => new Promise((resolve, reject) => {
    pending.push({ id, signal, resolve })
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }), async () => { lists++; return [] })
  view.watch('a', true)
  event('turn/start', { turn: 1 })
  emit('getApp', {}, { appHandle: 'app', name: 'Editor' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  const last = pending.at(-1)
  event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(last.signal.aborted, true)
  assert.equal(windows.get('a/app/1').activity, 'completed')
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  const before = lists
  event('turn/start', { turn: 2 }); event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(lists, before)
  event('turn/start', { turn: 3 })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  assert.equal(windows.get('a/app/1').activity, undefined)
  assert.equal(pending.at(-1).signal.aborted, false)
  preview.close()
})

test('screen permission failure stops retries and a later operation can recover', async () => {
  const listeners = new Map(), windows = new Map()
  let allowed = false, captures = 0, lists = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  preview.hooks.onClient(agent, async (_handle, windowId) => {
    captures++
    if (!allowed) throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' })
    return { windowId, data: 'YWJj', mimeType: 'image/png' }
  }, async () => { lists++; return [] })
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  view.watch('a', true)
  emit('getApp', {}, { appHandle: 'app', name: 'Editor' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('a/app/1').previewIssue, 'screenRecording')
  const before = { captures, lists }
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.deepEqual({ captures, lists }, before)
  allowed = true
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('a/app/1').previewIssue, undefined)
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  preview.close()
})

test('turn cancellation stops an in-flight preview before the turn closes', async () => {
  const listeners = new Map(), windows = new Map(), pending = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }, turn = new AbortController()
  preview.hooks.onClient(agent, (_handle, windowId, signal) => new Promise((resolve, reject) => {
    pending.push({ windowId, signal, resolve })
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }))
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: turn.signal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  listeners.get('session/event')({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  listeners.get('agent-loop/turn-signal')('a', turn.signal)
  emit('getApp', {}, { appHandle: 'app', name: 'Editor' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
  turn.abort()
  assert.equal(pending[0].signal.aborted, true)
  assert.equal(windows.get('a/app/1').activity, 'stopped')
  preview.close()
})

test('a tool result arriving after an early turn cancellation cannot start preview capture', async () => {
  const listeners = new Map(), windows = new Map(), turn = new AbortController()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  let captures = 0
  preview.hooks.onClient(agent, async () => { captures++; return 'data:image/png;base64,AAAA' })
  listeners.get('session/event')({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  listeners.get('agent-loop/turn-signal')('a', turn.signal)
  turn.abort()
  listeners.get('tools/result')({ signal: turn.signal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Editor' } })
  listeners.get('tools/result')({ signal: turn.signal, name: 'cua', agent, arguments: { method: 'getState', params: { appHandle: 'app', windowId: 1 } } }, { isError: false, value: { windowId: 1 } })
  assert.equal(captures, 0)
  assert.equal(windows.size, 0)
  preview.close()
})

test('native previews follow final outcomes, isolate windows and clear on disposal', () => {
  const listeners = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const windows = new Map()
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view)
  const agent = { id: 'a' }, other = { id: 'b' }
  const emit = (owner, method, params, value, isError = false) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent: owner, arguments: { method, params } }, isError ? { isError: true } : { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value, isError = false) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, isError ? { isError: true } : { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, title: 'One', isOnScreen: true }] })
  view.dismiss('a/app/1'); view.remove('a/app/1')
  emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
  assert.equal(windows.get('a/app/1').action, 'click')
  preview.close()
})

test('listing windows does not reopen a dismissed selected preview', () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, title: 'One', isOnScreen: true }] })
  view.dismiss('a/app/1'); view.remove('a/app/1')
  emit('listWindows', { appHandle: 'app' }, [{ windowId: 1, title: 'One', isOnScreen: true }])
  assert.equal(windows.has('a/app/1'), false)
  emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,YWJj')
  preview.close()
})

test('a denied preview capture clears an earlier image', async () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  let allowed = true
  preview.hooks.onClient(agent, async (_handle, windowId) => { if (!allowed) throw new Error('access revoked'); return { windowId, data: 'YWJj', mimeType: 'image/png' } })
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
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
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
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
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
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
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  for (let i = 0; i < 100 && !scans; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(scans, 1)
  assert.equal(windows.get('auto/app/status').discoveryUnavailable, true)
  preview.close()
})

test('background discovery never runs when application selection is denied', async () => {
  const listeners = new Map(); let scans = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put() { assert.fail('denied application produced a card') }, remove() {} }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  preview.hooks.onClient(agent, async () => { throw new Error('unexpected capture') }, async () => { scans++; return [] })
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: true })
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
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
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
  const emit = (method, params, value) => { modelCalls++; listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value }) }
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

test('display-only discovery keeps tiny windows, ignores transient and hidden rows, and isolates owners', async () => {
  const listeners = new Map(), windows = new Map(), scans = new Map(), captures = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 })
  const a = { id: 'session-a' }, b = { id: 'session-b' }
  const row = (windowId, title, width, height, extra = {}) => ({ windowId, title, bounds: { width, height }, isOnScreen: true, onCurrentSpace: true, ...extra })
  const list = owner => async handle => {
    const key = `${owner.id}/${handle}`; const count = (scans.get(key) ?? 0) + 1; scans.set(key, count)
    if (owner === b) return [row(1, 'Other session', 200, 100)]
    if (handle === 'second') return [row(1, 'Other app', 240, 120)]
    return [row(1, 'Normal', 600, 400), row(2, 'Small legitimate window', 1, 1),
      ...(count === 1 ? [row(3, 'Transient', 90, 50)] : []),
      row(4, 'Zero width', 0, 50), row(5, 'Off-screen', 100, 100, { isOnScreen: false }),
      row(6, 'Other space', 100, 100, { onCurrentSpace: false })]
  }
  const capture = owner => async (handle, windowId) => {
    const tag = `${owner.id}/${handle}/${windowId}`; captures.push(tag)
    return { windowId, data: Buffer.from(tag).toString('base64'), mimeType: 'image/png' }
  }
  const app = (agent, handle, name) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: handle, name } })
  const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'discovery timed out') }
  try {
    preview.hooks.onClient(a, capture(a), list(a)); preview.hooks.onClient(b, capture(b), list(b))
    app(a, 'first', 'First'); app(a, 'second', 'Second'); app(b, 'first', 'Third')
    view.watch('session-a', true)
    await until(() => ['session-a/first/1', 'session-a/first/2', 'session-a/second/1'].every(id => windows.get(id)?.image))
    assert.deepEqual([...windows.keys()].sort(), ['session-a/first/1', 'session-a/first/2', 'session-a/second/1'])
    assert.equal(scans.has('session-b/first'), false)
    view.watch('session-b', true)
    await until(() => windows.get('session-b/first/1')?.image)
    for (const id of ['session-a/first/1', 'session-a/first/2', 'session-a/second/1', 'session-b/first/1']) {
      assert.equal(windows.get(id).image, `data:image/png;base64,${Buffer.from(id).toString('base64')}`)
    }
    assert.ok(captures.includes('session-a/first/2'))
    assert.equal(windows.has('session-a/first/3'), false)
  } finally { preview.close() }
})

test('discovery failure is isolated to its app and clears after recovery', async () => {
  const listeners = new Map(), windows = new Map(), counts = { first: 0, second: 0 }, frames = { first: 0, second: 0 }
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  let failure = false
  preview.hooks.onClient(agent, async (handle, windowId) => ({ windowId, data: Buffer.from(`${handle}/${++frames[handle]}`).toString('base64'), mimeType: 'image/png' }), async handle => {
    counts[handle]++
    if (failure && handle === 'first') throw Object.assign(new Error('unavailable'), { code: 'NATIVE_ERROR' })
    return (handle === 'first' ? [1, 2] : [1]).map(windowId => ({ windowId, title: `${handle}-${windowId}`, bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }))
  })
  const emitApp = handle => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: handle, name: handle } })
  const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'discovery timed out') }
  try {
    emitApp('first'); emitApp('second'); view.watch('a', true)
    await until(() => windows.get('a/first/1')?.image && windows.get('a/first/2')?.image && windows.get('a/second/1')?.image)
    const firstImages = [windows.get('a/first/1').image, windows.get('a/first/2').image], secondFrames = frames.second
    failure = true
    await until(() => windows.get('a/first/1')?.discoveryUnavailable && windows.get('a/first/2')?.discoveryUnavailable && counts.first >= 5 && frames.second > secondFrames)
    assert.deepEqual([windows.get('a/first/1').image, windows.get('a/first/2').image], firstImages)
    assert.equal(windows.has('a/first/status'), false)
    assert.equal(windows.has('a/second/status'), false)
    assert.equal(windows.get('a/second/1').discoveryUnavailable, undefined)
    failure = false
    await until(() => !windows.get('a/first/1').discoveryUnavailable && !windows.get('a/first/2').discoveryUnavailable)
  } finally { preview.close() }
})

test('cancelled discovery after revocation cannot publish a failure or resume', async () => {
  const listeners = new Map(), windows = new Map(); let pending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  preview.hooks.onClient(agent, async () => { throw new Error('unexpected capture') }, (_handle, signal) => new Promise((_resolve, reject) => { pending = { signal, reject } }))
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  try {
    view.watch('a', true)
    for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(pending)
    preview.hooks.onRevoke(agent, 'app'); assert.equal(pending.signal.aborted, true)
    pending.reject(Object.assign(new Error('late'), { code: 'NATIVE_ERROR' }))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(windows.size, 0)
  } finally { preview.close() }
})

test('unrelated reads do not prevent automatic discovery and refresh', async () => {
  const listeners = new Map(), windows = new Map(); let scans = 0, captures = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 20 }), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: Buffer.from(String(++captures)).toString('base64'), mimeType: 'image/png' }), async () => { scans++; return [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }] })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' }); view.watch('a', true)
  const timer = setInterval(() => emit('getCapabilities', {}, {}), 5)
  try {
    for (let i = 0; i < 200 && captures < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(scans >= 3 && captures >= 2, 'automatic preview did not refresh during unrelated reads')
    assert.ok(windows.get('a/app/1').image)
  } finally { clearInterval(timer); preview.close() }
})

test('a targeted operation cancels an in-flight background frame', async () => {
  const listeners = new Map(), windows = new Map(); let pending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  preview.hooks.onClient(agent, (_handle, windowId, signal) => new Promise(resolve => { pending = { windowId, signal, resolve } }), async () => [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }])
  try {
    emit('getApp', {}, { appHandle: 'app', name: 'Fixture' }); view.watch('a', true)
    for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(pending)
    emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'bmV3', mimeType: 'image/png' })
    assert.equal(pending.signal.aborted, true)
    pending.resolve({ windowId: 1, data: 'b2xk', mimeType: 'image/png' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,bmV3')
  } finally { preview.close() }
})

test('discovery without windows shows one status until recovery', async () => {
  const listeners = new Map(), windows = new Map(); let failure = true, scans = 0, statusPuts = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { if (item.id.endsWith('/status')) statusPuts++; windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'YWJj', mimeType: 'image/png' }), async () => {
    scans++
    if (failure) throw Object.assign(new Error('unavailable'), { code: 'NATIVE_ERROR' })
    return [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }]
  })
  const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'discovery timed out') }
  try {
    listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
    view.watch('a', true)
    await until(() => scans >= 3)
    assert.equal(statusPuts, 1)
    assert.equal(windows.get('a/app/status').discoveryUnavailable, true)
    failure = false
    await until(() => windows.get('a/app/1')?.image)
    assert.equal(windows.has('a/app/status'), false)
  } finally { preview.close() }
})

test('background screenshot timeout keeps the last frame with a warning until recovery or revocation', async () => {
  const listeners = new Map(), windows = new Map(); let mode = 'success', count = 0, rejectPending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
  preview.hooks.onClient(agent, async (_handle, windowId) => {
    count++
    if (mode === 'timeout') throw Object.assign(new Error('timed out'), { code: 'NATIVE_TIMEOUT' })
    if (mode === 'pending') return new Promise((_resolve, reject) => { rejectPending = reject })
    return { windowId, data: mode === 'recovered' ? 'bmV3' : 'b2xk', mimeType: 'image/png' }
  }, async () => [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }])
  listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
  view.watch('auto', true)
  for (let i = 0; i < 200 && !windows.get('auto/app/1')?.image; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const initial = windows.get('auto/app/1'); assert.equal(initial.image, 'data:image/png;base64,b2xk')
  mode = 'timeout'
  for (let i = 0; i < 200 && !windows.get('auto/app/1')?.previewUnavailable; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const timedOut = windows.get('auto/app/1'); assert.equal(timedOut.image, initial.image); assert.equal(timedOut.capturedAt, initial.capturedAt)
  mode = 'recovered'
  for (let i = 0; i < 200 && windows.get('auto/app/1')?.previewUnavailable; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(windows.get('auto/app/1').image, 'data:image/png;base64,bmV3')
  mode = 'pending'
  for (let i = 0; i < 200 && !rejectPending; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(rejectPending); preview.hooks.onRevoke(agent, 'app')
  rejectPending(Object.assign(new Error('timed out'), { code: 'NATIVE_TIMEOUT' }))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(windows.size, 0); assert.ok(count >= 4)
  preview.close()
})

test('screenshot permission denial and lost application handles clear the retained frame', async () => {
  for (const code of ['PERMISSION_DENIED', 'STALE_APP', 'NATIVE_CLOSED']) {
    const listeners = new Map(), windows = new Map(); let failure
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
    preview.hooks.onClient(agent, async (_handle, windowId) => {
      if (failure) throw Object.assign(new Error('unavailable'), { code: failure })
      return { windowId, data: 'b2xk', mimeType: 'image/png' }
    }, async () => [{ windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }])
    listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method: 'getApp', params: {} } }, { isError: false, value: { appHandle: 'app', name: 'Fixture' } })
    view.watch('auto', true)
    for (let i = 0; i < 200 && !windows.get('auto/app/1')?.image; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(windows.get('auto/app/1')?.image, code); failure = code
    for (let i = 0; i < 200 && !windows.get('auto/app/1')?.previewUnavailable; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(windows.get('auto/app/1').image, undefined, code)
    assert.equal(windows.get('auto/app/1').capturedAt, undefined, code)
    preview.close()
  }
})

test('connection failures during window discovery clear every application on that connection', async () => {
  for (const code of ['PERMISSION_DENIED', 'NATIVE_CLOSED', 'NATIVE_DISPOSED', 'NATIVE_CLEANUP', 'NATIVE_IO', 'NATIVE_EOF', 'NATIVE_EXITED', 'NATIVE_PROTOCOL', 'NATIVE_RESPONSE_LIMIT']) {
    const listeners = new Map(), windows = new Map(); let failed = false
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'auto' }
    preview.hooks.onClient(agent, async () => { throw new Error('unexpected screenshot') }, async () => { failed = true; throw Object.assign(new Error('connection lost'), { code }) })
    const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    for (const appHandle of ['first', 'second']) {
      emit('getApp', {}, { appHandle, name: appHandle })
      emit('screenshot', { appHandle, windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
    }
    assert.ok(windows.get('auto/first/1')?.image); assert.ok(windows.get('auto/second/1')?.image)
    view.watch('auto', true)
    for (let i = 0; i < 100 && !failed; i++) await new Promise(resolve => setTimeout(resolve, 5))
    for (const appHandle of ['first', 'second']) {
      const item = windows.get(`auto/${appHandle}/1`)
      assert.equal(item.image, undefined, `${code} ${appHandle}`); assert.equal(item.discoveryUnavailable, true, `${code} ${appHandle}`)
    }
    preview.close()
  }
})

test('action-triggered capture distinguishes timeout from connection-wide permission loss', async () => {
  const listeners = new Map(), windows = new Map(); let failure = 'NATIVE_TIMEOUT'
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'auto' }
  preview.hooks.onClient(agent, async () => { throw Object.assign(new Error('capture failed'), { code: failure }) })
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  for (const appHandle of ['first', 'second']) {
    emit('getApp', {}, { appHandle, name: appHandle })
    emit('screenshot', { appHandle, windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
  }
  emit('click', { appHandle: 'first', windowId: 1 }, { dispatched: true }); await new Promise(resolve => setImmediate(resolve))
  assert.ok(windows.get('auto/first/1').image); assert.equal(windows.get('auto/first/1').previewUnavailable, true)
  assert.ok(windows.get('auto/second/1').image)
  failure = 'PERMISSION_DENIED'
  emit('click', { appHandle: 'first', windowId: 1 }, { dispatched: true }); await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.get('auto/first/1').image, undefined); assert.equal(windows.get('auto/second/1').image, undefined)
  preview.close()
})

test('another agent disposal or tool result does not interrupt an active preview', async () => {
  for (const action of ['dispose', 'tool-result', 'unwatch-other', 'unwatch-shared']) {
    const listeners = new Map(), windows = new Map(); let pending
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), a = { id: 'a' }, b = { id: 'b' }
    const emit = (agent, method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    emit(a, 'getApp', {}, { appHandle: 'app-a', name: 'A' })
    emit(b, 'getApp', {}, { appHandle: 'app-b', name: 'B' })
    emit(b, 'screenshot', { appHandle: 'app-b', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
    preview.hooks.onClient(b, async (_handle, windowId) => ({ windowId, data: 'bmV3', mimeType: 'image/png' }), (_handle, signal) => new Promise(resolve => { pending = { signal, resolve } }))
    if (action === 'unwatch-other') view.watch('a', true)
    view.watch('b', true)
    if (action === 'unwatch-shared') view.watch('b', true)
    for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(pending)
    if (action === 'dispose') listeners.get('agent/disposed')({ agent: a })
    else if (action === 'tool-result') emit(a, 'getState', { appHandle: 'app-a', windowId: 1 }, { windowId: 1, windows: [{ windowId: 1, isOnScreen: true }] })
    else if (action === 'unwatch-other') view.watch('a', false)
    else view.watch('b', false)
    assert.equal(pending.signal.aborted, false, action)
    pending.resolve([{ windowId: 1, title: 'B', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }])
    for (let i = 0; i < 100 && windows.get('b/app-b/1')?.image !== 'data:image/png;base64,bmV3'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(windows.get('b/app-b/1').image, 'data:image/png;base64,bmV3', action)
    preview.close()
  }
})

test('candidate eligibility is rechecked after another agent list completes', async () => {
  for (const action of ['unwatch', 'rewatch', 'revoke', 'reauthorize', 'client-replace', 'dismiss']) {
    const listeners = new Map(), windows = new Map(); let pending, shots = 0, scanA = 0, scansB = 0, shotScans = []
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), b = { id: 'b' }, a = { id: 'a' }
    try {
    const emit = (agent, method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    emit(b, 'getApp', {}, { appHandle: 'b-app', name: 'B' }); emit(a, 'getApp', {}, { appHandle: 'a-app', name: 'A' })
    emit(b, 'screenshot', { appHandle: 'b-app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
    const attachB = () => preview.hooks.onClient(b, async (_handle, windowId) => { shots++; shotScans.push(scansB); return { windowId, data: 'bmV3', mimeType: 'image/png' } }, async () => { scansB++; return [{ windowId: 1, title: 'B', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }] })
    attachB()
    preview.hooks.onClient(a, async () => { throw new Error('unexpected A capture') }, (_handle, signal) => { scanA++; return scanA === 1 ? new Promise(resolve => { pending = { signal, resolve } }) : Promise.resolve([]) })
    view.watch('b', true); view.watch('a', true)
    for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(pending)
    if (action === 'unwatch' || action === 'rewatch') {
      view.watch('b', false)
      if (action === 'rewatch') view.watch('b', true)
    } else if (action === 'revoke' || action === 'reauthorize') {
      preview.hooks.onRevoke(b, 'b-app')
      if (action === 'reauthorize') {
        emit(b, 'getApp', {}, { appHandle: 'b-app', name: 'B again' }); attachB()
        emit(b, 'screenshot', { appHandle: 'b-app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      }
    } else if (action === 'client-replace') attachB()
    else { view.dismiss('b/b-app/1'); view.remove('b/b-app/1') }
    assert.equal(pending.signal.aborted, false, action)
    pending.resolve([])
    await new Promise(resolve => setTimeout(resolve, 5))
    if (action === 'reauthorize') assert.ok(shotScans.every(count => count >= 2), 'old discovery was used for new authorization')
    else assert.equal(shots, 0, action)
    if (action === 'unwatch' || action === 'rewatch' || action === 'reauthorize' || action === 'client-replace') {
      if (action === 'unwatch') view.watch('b', true)
      for (let i = 0; i < 100 && shots === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(shots > 0, 'resubscribing did not resume capture')
    } else if (action === 'revoke') assert.equal(windows.has('b/b-app/1'), false)
    } finally { preview.close() }
  }
})

test('late capture errors cannot clear a newer watcher, application, window or client', async () => {
  for (const change of ['watcher', 'application', 'window', 'client']) {
    const listeners = new Map(), windows = new Map(); let pending
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
    try {
      const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
      const list = async () => [{ windowId: 1, title: 'Window', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }]
      emit('getApp', {}, { appHandle: 'app', name: 'A' })
      emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      preview.hooks.onClient(agent, (_handle, _window, signal) => new Promise((_resolve, reject) => { pending = { signal, reject } }), list)
      view.watch('a', true)
      for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(pending, change)
      if (change === 'watcher') { view.watch('a', false); view.watch('a', true) }
      if (change === 'application') { preview.hooks.onRevoke(agent, 'app'); emit('getApp', {}, { appHandle: 'app', name: 'A again' }) }
      if (change === 'window') { view.dismiss('a/app/1'); view.remove('a/app/1') }
      if (change === 'client' || change === 'application') preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'bmV3', mimeType: 'image/png' }), list)
      if (change !== 'client') emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'bmV3', mimeType: 'image/png' })
      pending.reject(Object.assign(new Error('old failure'), { code: 'PERMISSION_DENIED' }))
      await new Promise(resolve => setImmediate(resolve))
      const current = windows.get('a/app/1')
      assert.equal(current?.image, change === 'client' ? 'data:image/png;base64,b2xk' : 'data:image/png;base64,bmV3', change)
      assert.notEqual(current?.previewUnavailable, true, change)
    } finally { preview.close() }
  }
})

test('a replaced client never consumes old discovery success or failure', async () => {
  for (const result of ['success', 'error']) {
    const listeners = new Map(), windows = new Map(); let pending, oldCalls = 0, newLists = 0, newShots = 0
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 20 }), agent = { id: 'a' }
    try {
      const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
      const rows = [{ windowId: 1, title: 'Window', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }]
      emit('getApp', {}, { appHandle: 'app', name: 'A' })
      emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      preview.hooks.onClient(agent, async () => { oldCalls++; throw new Error('old client capture') }, (_handle, signal) => new Promise((resolve, reject) => { pending = { signal, resolve, reject } }))
      view.watch('a', true)
      for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(pending)
      preview.hooks.onClient(agent, async (_handle, windowId) => { newShots++; return { windowId, data: 'bmV3', mimeType: 'image/png' } }, async () => { newLists++; return rows })
      if (result === 'success') pending.resolve(rows)
      else pending.reject(Object.assign(new Error('old permission'), { code: 'PERMISSION_DENIED' }))
      await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(oldCalls, 0, result); assert.equal(newShots, 0, result)
      assert.equal(windows.get('a/app/1')?.image, 'data:image/png;base64,b2xk', result)
      assert.notEqual(windows.get('a/app/1')?.discoveryUnavailable, true, result)
      for (let i = 0; i < 100 && newShots === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(newLists > 0 && newShots > 0, result)
    } finally { preview.close() }
  }
})

test('old discovery replies cannot alter a resubscribed or reauthorized application', async () => {
  for (const change of ['watcher', 'application']) for (const outcome of ['success', 'error']) {
    const listeners = new Map(), windows = new Map(); let pending, freshLists = 0
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 20 }), agent = { id: 'a' }
    try {
      const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
      const rows = [{ windowId: 1, title: 'New', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }]
      emit('getApp', {}, { appHandle: 'app', name: 'A' })
      emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'bmV3', mimeType: 'image/png' }), (_handle, signal) => new Promise((resolve, reject) => { pending = { signal, resolve, reject } }))
      view.watch('a', true)
      for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(pending)
      if (change === 'watcher') { view.watch('a', false); view.watch('a', true) }
      else { preview.hooks.onRevoke(agent, 'app'); emit('getApp', {}, { appHandle: 'app', name: 'A again' }) }
      preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'bmV3', mimeType: 'image/png' }), async () => { freshLists++; return rows })
      if (change === 'application') emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      if (outcome === 'success') pending.resolve([{ ...rows[0], title: 'Old title' }])
      else pending.reject(Object.assign(new Error('old permission'), { code: 'PERMISSION_DENIED' }))
      await new Promise(resolve => setTimeout(resolve, 5))
      const item = windows.get('a/app/1')
      assert.equal(item?.image, 'data:image/png;base64,b2xk', `${change} ${outcome}`)
      assert.notEqual(item?.discoveryUnavailable, true, `${change} ${outcome}`)
      assert.doesNotMatch(item?.title ?? '', /Old title/, `${change} ${outcome}`)
      for (let i = 0; i < 100 && freshLists === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(freshLists > 0, `${change} ${outcome}`)
    } finally { preview.close() }
  }
})

test('list observations preserve active captures only while window state is unchanged', async () => {
  for (const change of ['same', 'resize', 'hidden', 'closed', 'failure']) {
    const listeners = new Map(), windows = new Map(); let pending
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
    try {
      const row = { windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }
      const emit = (method, params, value, isError = false) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, isError ? { isError: true, error: { message: 'PERMISSION_DENIED: fixture denial' } } : { isError: false, value })
      emit('getApp', {}, { appHandle: 'app', name: 'A' })
      emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png' })
      preview.hooks.onClient(agent, (_handle, _windowId, signal) => new Promise(resolve => { pending = { signal, resolve } }), async () => [row])
      view.watch('a', true)
      for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(pending, change)
      const observed = change === 'closed' ? [] : [{ ...row, bounds: change === 'resize' ? { width: 200, height: 100 } : row.bounds, isOnScreen: change !== 'hidden' }]
      emit('listWindows', { appHandle: 'app' }, observed, change === 'failure')
      assert.equal(pending.signal.aborted, change === 'failure', change)
      pending.resolve({ windowId: 1, data: 'bmV3', mimeType: 'image/png' })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(windows.get('a/app/1')?.image, change === 'same' ? 'data:image/png;base64,bmV3' : change === 'failure' ? undefined : 'data:image/png;base64,b2xk', change)
      if (change === 'resize') assert.equal(windows.get('a/app/1')?.previewUnavailable, true)
      if (change === 'hidden' || change === 'closed') assert.equal(windows.get('a/app/1')?.windowUnavailable, true)
    } finally { preview.close() }
  }
})

test('screenshot dimensions establish the first list baseline and invalidate old click coordinates on resize', () => {
  const listeners = new Map(), windows = new Map()
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view), agent = { id: 'a' }
  try {
    const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    emit('getApp', {}, { appHandle: 'app', name: 'A' })
    emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png', pixelWidth: 100, pixelHeight: 100, bounds: { width: 100, height: 100 } })
    emit('click', { appHandle: 'app', windowId: 1, x: 25, y: 25 }, { dispatched: true })
    assert.ok(windows.get('a/app/1').point)
    emit('listWindows', { appHandle: 'app' }, [{ windowId: 1, title: 'One', bounds: { width: 200, height: 100 }, isOnScreen: true }])
    assert.equal(windows.get('a/app/1').previewUnavailable, true)
    assert.equal(windows.get('a/app/1').point, undefined)
    emit('click', { appHandle: 'app', windowId: 1, x: 25, y: 25 }, { dispatched: true })
    assert.equal(windows.get('a/app/1').point, undefined)
  } finally { preview.close() }
})

test('a cancelled old frame cannot replace the size from a newer screenshot', async () => {
  const listeners = new Map(), windows = new Map(); let pending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  try {
    const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    const row = { windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true }
    emit('getApp', {}, { appHandle: 'app', name: 'A' })
    emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png', bounds: row.bounds })
    preview.hooks.onClient(agent, (_h, _id, signal) => new Promise(resolve => { pending = { signal, resolve } }), async () => [row])
    view.watch('a', true)
    for (let i = 0; i < 100 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(pending)
    emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'bmV3', mimeType: 'image/png', bounds: { width: 200, height: 100 } })
    assert.equal(pending.signal.aborted, true)
    pending.resolve({ windowId: 1, data: 'b2xk', mimeType: 'image/png', bounds: { width: 100, height: 100 } })
    await new Promise(resolve => setImmediate(resolve))
    emit('listWindows', { appHandle: 'app' }, [{ ...row, bounds: { width: 200, height: 100 } }])
    assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,bmV3')
    assert.equal(windows.get('a/app/1').previewUnavailable, false)
  } finally { preview.close() }
})

test('window changes cancel action-triggered captures and ignore late frames', async () => {
  for (const change of ['resize', 'hidden', 'closed']) {
    const listeners = new Map(), windows = new Map(); let pending
    const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
    const view = { setDismissHandler() {}, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
    const preview = observeNative(ctx, view), agent = { id: 'a' }
    try {
      const row = { windowId: 1, title: 'One', bounds: { width: 100, height: 100 }, isOnScreen: true }
      const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
      emit('getApp', {}, { appHandle: 'app', name: 'A' })
      emit('screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'b2xk', mimeType: 'image/png', bounds: row.bounds })
      preview.hooks.onClient(agent, (_handle, _id, signal) => new Promise(resolve => { pending = { signal, resolve } }))
      emit('click', { appHandle: 'app', windowId: 1 }, { dispatched: true })
      assert.ok(pending, change)
      const rows = change === 'closed' ? [] : [{ ...row, bounds: change === 'resize' ? { width: 200, height: 100 } : row.bounds, isOnScreen: change !== 'hidden' }]
      emit('listWindows', { appHandle: 'app' }, rows)
      assert.equal(pending.signal.aborted, true, change)
      pending.resolve({ windowId: 1, data: 'bmV3', mimeType: 'image/png', bounds: row.bounds })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(windows.get('a/app/1').image, 'data:image/png;base64,b2xk', change)
      if (change === 'resize') assert.equal(windows.get('a/app/1').previewUnavailable, true)
    } finally { preview.close() }
  }
})

test('automatic previews rotate by window identity when discovery order changes', async () => {
  const listeners = new Map(), windows = new Map(), shots = []; let scans = 0
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), agent = { id: 'a' }
  try {
    const row = windowId => ({ windowId, title: `Window ${windowId}`, bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true })
    const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
    for (const windowId of [1, 2]) emit('screenshot', { appHandle: 'app', windowId }, { windowId, data: 'YWJj', mimeType: 'image/png' })
    let ids = [1, 2]
    preview.hooks.onClient(agent, async (_handle, windowId) => { shots.push(windowId); return { windowId, data: 'YWJj', mimeType: 'image/png' } }, async () => { scans++; const order = scans % 2 ? ids : [...ids].reverse(); return order.map(row) })
    view.watch('a', true)
    const until = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition()) }
    await until(() => shots.length >= 8)
    assert.deepEqual(shots.slice(0, 8), [1, 2, 1, 2, 1, 2, 1, 2])
    ids = [1, 2, 3]
    await until(() => shots.includes(3))
    view.dismiss('a/app/2'); view.remove('a/app/2'); ids = [1, 3]
    const cutoff = shots.length
    await until(() => shots.length >= cutoff + 6)
    assert.equal(shots.slice(cutoff).includes(2), false)
    assert.deepEqual(new Set(shots.slice(cutoff)), new Set([1, 3]))
    view.watch('a', false)
    const stopped = shots.length; await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(shots.length, stopped)
  } finally { preview.close() }
})

test('a failing capture cannot starve another application and revoked sessions stop', async () => {
  const listeners = new Map(), windows = new Map(), attempts = []
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler() {}, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = observeNative(ctx, view, { intervalMs: 10 }), a = { id: 'a' }, b = { id: 'b' }
  try {
    const emit = (agent, method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    const row = { windowId: 1, title: 'Window', bounds: { width: 100, height: 100 }, isOnScreen: true, onCurrentSpace: true }
    for (const agent of [a, b]) {
      emit(agent, 'getApp', {}, { appHandle: 'app', name: agent.id })
      emit(agent, 'screenshot', { appHandle: 'app', windowId: 1 }, { windowId: 1, data: 'YWJj', mimeType: 'image/png' })
      preview.hooks.onClient(agent, async (_handle, windowId) => { attempts.push(agent.id); if (agent === a) throw Object.assign(new Error('fixture'), { code: 'STALE_APP' }); return { windowId, data: 'YWJj', mimeType: 'image/png' } }, async () => [row])
      view.watch(agent.id, true)
    }
    for (let i = 0; i < 200 && attempts.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(attempts.slice(0, 6), ['a', 'b', 'a', 'b', 'a', 'b'])
    preview.hooks.onRevoke(a, 'app'); view.watch('a', false)
    const cutoff = attempts.length
    for (let i = 0; i < 200 && attempts.length < cutoff + 3; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(attempts.slice(cutoff, cutoff + 3), ['b', 'b', 'b'])
    assert.equal(windows.has('a/app/1'), false)
  } finally { preview.close() }
})

test('size bookkeeping retires transient windows while retaining pinned-window resize baselines', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../packages/perse-cua/lib/types/native-preview.js', import.meta.url), 'utf8')
  const instrumented = source.replace('windowSizes: new Map()', 'windowSizes: (globalThis.__previewSizeAudit = new Map())')
  assert.notEqual(instrumented, source)
  const { observeNative: instrumentedPreview } = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`)
  const listeners = new Map(), windows = new Map(); let rows = [], scans = 0, pending
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = { setDismissHandler(fn) { this.dismiss = fn }, setWatchHandler(fn) { this.watch = fn }, put(item) { windows.set(item.id, item) }, remove(id) { windows.delete(id) } }
  const preview = instrumentedPreview(ctx, view, { intervalMs: 5 }), agent = { id: 'a' }
  try {
    const row = (windowId, width) => ({ windowId, title: `Window ${windowId}`, bounds: { width, height: 100 }, isOnScreen: true, onCurrentSpace: true })
    const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
    const until = async check => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(check()) }
    emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
    preview.hooks.onClient(agent, (_handle, windowId) => new Promise(resolve => { pending = { windowId, resolve } }), async () => { scans++; return rows })
    view.watch('a', true)
    for (let windowId = 100; windowId < 120; windowId++) {
      rows = [row(windowId, 100)]; const before = scans; await until(() => scans > before)
    }
    rows = []; const before = scans; await until(() => scans > before)
    assert.equal(windows.size, 0)
    assert.equal(globalThis.__previewSizeAudit.size, 0, 'transient windows retained size records')
    emit('screenshot', { appHandle: 'app', windowId: 7 }, { windowId: 7, data: 'YWJj', mimeType: 'image/png', bounds: { width: 320, height: 100 } })
    const beforeMissing = scans; await until(() => scans >= beforeMissing + 2)
    assert.deepEqual(globalThis.__previewSizeAudit.get(7), { width: 320, height: 100 })
    assert.equal(windows.get('a/app/7').windowUnavailable, true)
    rows = [row(7, 640)]
    await until(() => windows.get('a/app/7')?.previewUnavailable && pending?.windowId === 7)
    assert.deepEqual(globalThis.__previewSizeAudit.get(7), { width: 640, height: 100 })
    pending.resolve({ windowId: 7, data: 'bmV3', mimeType: 'image/png', bounds: { width: 640, height: 100 } })
    await until(() => windows.get('a/app/7')?.image === 'data:image/png;base64,bmV3')
    view.dismiss('a/app/7'); view.remove('a/app/7')
    assert.equal(globalThis.__previewSizeAudit.has(7), false)
    preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'YWJj', mimeType: 'image/png', bounds: { width: 100, height: 100 } }), async () => { scans++; return rows })
    rows = [row(9, 100)]
    await until(() => windows.get('a/app/9')?.image)
    rows = []
    await until(() => !windows.has('a/app/9'))
    assert.equal(globalThis.__previewSizeAudit.has(9), false, 'removed automatic window retained size')
  } finally { preview.close(); delete globalThis.__previewSizeAudit }
})

test('background window disappearance clears pending click frames while retaining last images', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { PreviewService } = await import('../packages/perse-cua/lib/types/view.js')
  const listeners = new Map(), ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const view = new PreviewService(new Context()), preview = observeNative(ctx, view, { intervalMs: 40 }), agent = { id: 'gone' }
  let scans = 0, rows = [1, 2].map(windowId => ({ windowId, title: `Window ${windowId}`, bounds: { width: 100, height: 100 }, isOnScreen: true }))
  const emit = (method, params, value) => listeners.get('tools/result')({ signal: testSignal, name: 'cua', agent, arguments: { method, params } }, { isError: false, value })
  preview.hooks.onClient(agent, async (_handle, windowId) => ({ windowId, data: 'YWJj', mimeType: 'image/png', bounds: { width: 100, height: 100 } }), async () => { scans++; return rows })
  emit('getApp', {}, { appHandle: 'app', name: 'Fixture' })
  const controller = new AbortController(), reader = view.watch(agent.id, controller.signal)[Symbol.asyncIterator]()
  await reader.next()
  for (let i = 0; i < 100 && (!view.windows.get('gone/app/1')?.image || !view.windows.get('gone/app/2')?.image); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(view.windows.get('gone/app/1')?.image); assert.ok(view.windows.get('gone/app/2')?.image)
  emit('getState', { appHandle: 'app', windowId: 1 }, { windowId: 1, windows: rows })
  await new Promise(resolve => setImmediate(resolve))
  emit('click', { appHandle: 'app', windowId: 1, relative: true, x: 250, y: 500 }, { dispatched: true })
  assert.ok(view.windows.get('gone/app/1').point)
  const auto = view.windows.get('gone/app/2')
  view.put({ ...auto, point: { x: 0.5, y: 0.5 } }, true)
  rows = []
  const start = scans
  for (let i = 0; i < 100 && scans < start + 1; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(scans >= start + 1)
  let items = (await reader.next()).value
  for (const item of items) { assert.equal(item.point, undefined); assert.ok(item.image) }
  assert.equal(items.find(item => item.id.endsWith('/1')).windowUnavailable, true)
  assert.ok(items.some(item => item.id.endsWith('/2')))
  for (let i = 0; i < 100 && scans < start + 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(scans >= start + 2)
  items = (await reader.next()).value
  assert.ok(items.some(item => item.id.endsWith('/2')))
  assert.ok(items.every(item => item.point === undefined && item.image))
  controller.abort(); await reader.return(); preview.close(); view.close()
})
