import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { NativeClient } from '../packages/perse-cua/vendor/dsh-cua.js'

const event = overrides => ({ type: 'visual', requestId: 'request', appHandle: 'app', windowId: 1, process: { pid: 1, startedSeconds: 1, startedMicroseconds: 2 }, geometry: { x: 10, y: 20, width: 100, height: 80 }, sequence: 1, color: '#5EC0E8', phase: 'move', trajectory: { samples: [{ t: 0, x: .1, y: .2, angle: 0 }, { t: .5, x: .8, y: .9, angle: .2 }], arrivalT: .5 }, elapsedMs: 0, ...overrides })
function fixture(supportsVisual) {
  const stdout = new PassThrough(), stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const handle = { stdout, stdin, supportsVisual, done: new Promise(() => {}), close() {}, waitForClose: async () => {} }
  const received = []
  const client = new NativeClient({}, { maxRequestBytes: 65536, maxResponseBytes: 65536, timeoutMs: 5000, screenshotTimeoutMs: 5000, graceMs: 50 }, () => handle, undefined, undefined, value => received.push(value))
  const pending = client.request('click', {}, new AbortController().signal, 'request')
  const send = value => stdout.write(`${JSON.stringify(value)}\n`)
  return { client, pending, received, send }
}
test('visual frames require negotiation, an active request and increasing sequence', async () => {
  for (const supported of [false, true]) {
    const { client, pending, received, send } = fixture(supported)
    send(event({ requestId: 'other' }))
    send(event({}))
    send(event({ phase: 'click' }))
    send(event({ sequence: 2, phase: 'position' }))
    assert.deepEqual(received.map(item => item.sequence), supported ? [1, 2] : [])
    send({ id: 'request', result: {} })
    await pending
    send(event({ sequence: 3 }))
    assert.deepEqual(received.map(item => item.sequence), supported ? [1, 2] : [])
    await client.dispose()
  }
})
test('malformed trajectories fail the native connection', async () => {
  const { client, pending, send } = fixture(true)
  send(event({ trajectory: { samples: [{ t: .5, x: 0, y: 0, angle: 0 }, { t: .4, x: 1, y: 1, angle: 0 }], arrivalT: .5 } }))
  await assert.rejects(pending, error => error.code === 'NATIVE_PROTOCOL')
  assert.equal(client.disposed, true)
})

test('post-reply clear is admitted only for the current window owner', async () => {
  const { client, pending, received, send } = fixture(true)
  send(event({}))
  send({ id: 'request', result: {} })
  await pending
  send(event({ sequence: 2, phase: 'clear', geometry: { x: 11, y: 20, width: 100, height: 80 } }))
  assert.equal(received.length, 1)
  send(event({ sequence: 3, phase: 'clear' }))
  assert.deepEqual(received.map(item => item.phase), ['move', 'clear'])
  send(event({ sequence: 4, phase: 'clear' }))
  assert.equal(received.length, 2)
  await client.dispose()
})
