/** Opt-in macOS integration: run only with desktop permissions on an owned fixture. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as Main from '../packages/perse-cua/lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'perse-host-resize-'))
const binary = join(root, 'Fixture.app/Contents/MacOS/fixture')
const ctx = new Context()
let fixture
try {
  await mkdir(join(root, 'Fixture.app/Contents/MacOS'), { recursive: true })
  await writeFile(join(root, 'Fixture.app/Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>local.perse.host-resize-fixture</string><key>CFBundleName</key><string>Perse Host Resize Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  execFileSync('swiftc', [fileURLToPath(new URL('../packages/perse-cua/native/tests/fixture/Resize.swift', import.meta.url)), '-o', binary])
  fixture = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'] })
  const [chunk] = await once(fixture.stdout, 'data'); assert.match(String(chunk), /READY/)
  for (const plugin of [Loader, Tools, Agents, Prompt, LocalSubprocess]) await ctx.plugin(plugin)
  ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
  ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] } } })
  const images = new Map()
  ctx.provide('attachments', {
    async saveImages(batch) { return batch.map(image => { const data = Buffer.from(image.data), id = String(images.size); images.set(id, data); return { id, width: data.readUInt32BE(16), height: data.readUInt32BE(20), mediaType: image.mediaType } }) },
    async readImageRequest(ref) { return { ...ref, data: images.get(ref.id) } },
  })
  ctx.provide('llm', { async resolveModelInfo() { return { inputModalities: ['image'] } }, imageRequestTarget() { return {} } })
  ctx.loader.builtins.perse = Main
  await ctx.loader.create({ id: 'perse-cua', name: 'cordis:perse', config: {} })
  await ctx.loader.await()
  for (let i = 0; i < 200 && !ctx.tools.get('cua'); i++) await delay(10)
  assert.ok(ctx.tools.get('cua'))
  const agent = { id: 'host-resize-fixture', ctx, session: { requestHeader: () => null }, options: { provider: 'fixture', model: 'fixture' } }
  ctx.agents.get = id => id === agent.id ? agent : undefined
  let sequence = 0
  const call = (method, params) => ctx.tools.execute({ name: 'cua', arguments: { method, params }, agent, callId: `resize-${++sequence}`, signal: new AbortController().signal })
  const checked = async (method, params) => { const result = await call(method, params); assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  const app = await checked('getApp', { selector: String(fixture.pid) })
  const windows = await checked('listWindows', { appHandle: app.appHandle })
  const window = windows.find(w => w.title === 'Perse resize fixture'); assert.ok(window)
  const target = { appHandle: app.appHandle, windowId: window.windowId }
  const state = await checked('getState', target)
  const resize = /\[(\d+)\] AXButton[^\n]*Resize fixture/.exec(state.tree); assert.ok(resize, state.tree)
  const firstController = new AbortController()
  const firstReader = ctx.get('perseCuaView').watch(agent.id, firstController.signal)[Symbol.asyncIterator]()
  for (let i = 0; i < 10; i++) await checked('listApps', {})
  const firstDeadline = Date.now() + 15000
  while (true) {
    const timeout = AbortSignal.timeout(Math.max(1, firstDeadline - Date.now()))
    const items = await Promise.race([firstReader.next().then(result => result.value), new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('First preview timeout after rapid operations')), { once: true }))])
    if (items.some(item => item.id.endsWith('/' + window.windowId) && item.image)) break
  }
  firstController.abort(); await firstReader.return()
  const modelImage = await checked('screenshot', target)
  assert.equal(modelImage.bounds.width, 400)
  const controller = new AbortController(); const reader = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
  await checked('click', { appHandle: app.appHandle, snapshotId: state.snapshotId, elementIndex: Number(resize[1]) })
  let preview
  const deadline = Date.now() + 15000
  while (!preview) {
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    const items = await Promise.race([reader.next().then(result => result.value), new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Preview timeout')), { once: true }))])
    const item = items.find(value => value.id.endsWith('/' + window.windowId))
    if (item?.image && item.action === 'click') {
      const data = Buffer.from(item.image.split(',')[1], 'base64')
      if (data.readUInt32BE(16) !== modelImage.pixelWidth) preview = item
    }
  }
  assert.ok(preview, 'resized automatic preview did not arrive')
  const stale = await call('click', { ...target, x: 20, y: 20 })
  assert.equal(stale.isError, true, JSON.stringify(stale))
  assert.match(JSON.stringify(stale.error), /WINDOW_CHANGED/)
  const refreshed = await checked('screenshot', target); assert.equal(refreshed.bounds.width, 500)
  const clickView = ctx.get('perseCuaView').watch(agent.id, controller.signal)[Symbol.asyncIterator]()
  await clickView.next()
  const marker = clickView.next()
  await checked('click', { ...target, x: 100, y: 100 })
  const marked = (await marker).value.find(item => item.id.endsWith('/' + window.windowId))
  assert.deepEqual(marked.point, { x: 100 / refreshed.pixelWidth, y: 100 / refreshed.pixelHeight })
  await clickView.return()
  controller.abort(); await reader.return()
  console.log('PASS: model screenshot, resize, automatic Host preview, stale coordinate refusal, fresh screenshot and click')
} finally {
  await ctx.fiber.dispose()
  if (fixture && fixture.exitCode === null) { fixture.kill(); await once(fixture, 'close') }
  await rm(root, { recursive: true, force: true })
}
