import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeRequestArbiter } from '../packages/perse-cua/vendor/native-request-arbiter.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('one connection alternates queued reads and preview requests without overlap', async () => {
  const queue = new NativeRequestArbiter(), signal = new AbortController().signal, order = [], gates = []
  let active = 0
  const run = name => async () => { assert.equal(++active, 1); order.push(name); await new Promise(resolve => gates.push(resolve)); active-- }
  const tasks = [queue.run('preview', signal, run('p1')), queue.run('preview', signal, run('p2')), queue.run('foreground', signal, run('f1')), queue.run('foreground', signal, run('f2'))]
  for (let i = 0; i < 4; i++) { await tick(); assert.ok(gates[i]); gates[i]() }
  await Promise.all(tasks); assert.deepEqual(order, ['p1', 'f1', 'p2', 'f2']); queue.close()
})
test('cancellation, preemption and close do not dispatch queued work', async () => {
  const queue = new NativeRequestArbiter(), controller = new AbortController(); let started = 0
  const first = queue.run('preview', new AbortController().signal, signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('preempted')), { once: true }))).catch(error => error.message)
  await tick()
  const cancelled = queue.run('foreground', controller.signal, () => { started++ }).catch(() => 'cancelled'); controller.abort()
  const action = queue.run('foreground', new AbortController().signal, () => { started++ }, { preempt: true })
  assert.equal(await first, 'preempted'); assert.equal(await cancelled, 'cancelled'); await action; assert.equal(started, 1)
  const blocked = queue.run('preview', new AbortController().signal, signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }))).catch(error => error.message)
  await tick()
  const queued = queue.run('foreground', new AbortController().signal, () => { started++ }).catch(error => error.message)
  queue.close(); assert.equal(await blocked, 'closed'); assert.match(await queued, /closed/); assert.equal(started, 1)
})


test('a queued request uses its existing wait budget and cannot dispatch later', async () => {
  const queue = new NativeRequestArbiter(); let release, called = false
  const active = queue.run('preview', new AbortController().signal, () => new Promise(resolve => { release = resolve }))
  await tick()
  await assert.rejects(queue.run('foreground', new AbortController().signal, () => { called = true }, { waitMs: 10 }), /timed out/)
  release(); await active; await tick(); assert.equal(called, false); queue.close()
})

test('input runs before an already queued preview after an active read', async () => {
  const queue = new NativeRequestArbiter(), signal = new AbortController().signal, order = []; let release, active = 0
  const run = name => async () => { assert.equal(++active, 1); order.push(name); active-- }
  const read = queue.run('foreground', signal, async () => { assert.equal(++active, 1); order.push('read'); await new Promise(resolve => { release = resolve }); active-- })
  await tick()
  const preview = queue.run('preview', signal, run('preview'))
  const input = queue.run('foreground', signal, run('input'), { preempt: true })
  release(); await Promise.all([read, preview, input])
  assert.deepEqual(order, ['read', 'input', 'preview']); queue.close()
})

test('preview preemption before dispatch reports NATIVE_CANCELLED without running it', async () => {
  const queue = new NativeRequestArbiter(), signal = new AbortController().signal; let ran = false
  const preview = queue.run('preview', signal, () => { ran = true }).catch(error => error)
  const input = queue.run('foreground', signal, () => 'input', { preempt: true })
  assert.equal((await preview).code, 'NATIVE_CANCELLED'); assert.equal(await input, 'input')
  assert.equal(ran, false); queue.close()
})

test('preempted active preview holds the slot until its cleanup settles', async () => {
  const queue = new NativeRequestArbiter(), signal = new AbortController().signal; let finish, started = false
  const preview = queue.run('preview', signal, async requestSignal => {
    await new Promise(resolve => requestSignal.addEventListener('abort', resolve, { once: true }))
    await new Promise(resolve => { finish = resolve })
    requestSignal.throwIfAborted()
  }).catch(error => error)
  await tick()
  const input = queue.run('foreground', signal, () => { started = true }, { preempt: true })
  await tick(); assert.equal(started, false); finish()
  assert.equal((await preview).code, 'NATIVE_CANCELLED'); await input; assert.equal(started, true); queue.close()
})

test('queued user cancellation and owner close retain distinct failure reasons', async () => {
  const queue = new NativeRequestArbiter(), ctrl = new AbortController(); let release
  const active = queue.run('foreground', new AbortController().signal, () => new Promise(resolve => { release = resolve }))
  await tick()
  const reason = new Error('user cancelled')
  const cancelled = queue.run('foreground', ctrl.signal, () => {}).catch(error => error); ctrl.abort(reason)
  assert.equal(await cancelled, reason)
  const queued = queue.run('foreground', new AbortController().signal, () => {}).catch(error => error)
  queue.close(); assert.equal((await queued).code, 'NATIVE_CLOSED'); release(); await active
})

test('preview queue expiry reports busy while foreground expiry reports timeout', async () => {
  const arbiter = new NativeRequestArbiter(), controller = new AbortController()
  let release
  const held = arbiter.run('foreground', controller.signal, () => new Promise(resolve => { release = resolve }))
  await Promise.resolve()
  const preview = arbiter.run('preview', controller.signal, () => assert.fail('preview dispatched'), { waitMs: 10 })
  const foreground = arbiter.run('foreground', controller.signal, () => assert.fail('foreground dispatched'), { waitMs: 10 })
  await assert.rejects(preview, error => error.code === 'NATIVE_BUSY')
  await assert.rejects(foreground, error => error.code === 'NATIVE_TIMEOUT')
  release(); await held; arbiter.close()
})
