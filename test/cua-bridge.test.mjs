import test from 'node:test'
import assert from 'node:assert/strict'
import { connectCua } from '../packages/perse-cua/vendor/dsh-cua-bridge.js'

test('bundled PTC bridge sends the explicit new-instance intent and retains its process identity', async () => {
  const requests = []
  const api = connectCua(() => async request => {
    requests.push(request)
    if (request.method === 'getApp') return { appHandle: 'selected', pid: 42, name: 'Calculator' }
    if (request.method === 'getState') return { appHandle: 'selected', pid: 42, windowId: request.params.windowId ?? null, snapshotId: 'snapshot', tree: 'Calculator', truncated: false, windows: [] }
    if (request.method === 'saveScreenshot') return { path: '/tmp/screenshot.png', mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 7, purpose: 'User screenshot artifact; the model has not seen its pixels.', modelReceivedImage: false }
    throw new Error(`Unexpected request ${request.method}`)
  })
  const app = await api.getApp('Calculator', { instance: 'new' })
  assert.deepEqual(requests[0], { method: 'getApp', params: { selector: 'Calculator', instance: 'new' } })
  assert.equal(app.pid, 42)
  assert.equal(requests[1].params.appHandle, app.appHandle)
  const window = await app.getWindow(7)
  const saved = await window.saveScreenshot({ emit: false })
  assert.equal(saved.modelReceivedImage, false)
  assert.equal(saved.path, '/tmp/screenshot.png')
  assert.deepEqual(requests.at(-1), { method: 'saveScreenshot', params: { appHandle: 'selected', windowId: 7 } })
})
