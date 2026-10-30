import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'

const source = readFileSync(new URL('../packages/perse-cua/client/index.jsx', import.meta.url), 'utf8')
  .replace("import React, { useEffect, useRef, useState } from 'react'", `const { React, useEffect, useRef, useState } = globalThis.__perseTestReact`)
  .replace("import remote from '../lib/typert.remote-client.js'", 'const remote = {}')

test('client reopens an ended preview stream and stops retrying when disposed', async () => {
  const effects = []
  globalThis.__perseTestReact = { React: { createElement: (...args) => args }, useEffect: fn => { const cleanup = fn(); if (cleanup) effects.push(cleanup) }, useRef: value => ({ current: value }), useState: value => [value, () => {}] }
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const ctx = new Context(); const controllers = []; let opens = 0; let View
  ctx.provide('locale', { register() { return () => {} } })
  ctx.provide('slots', { inject(_name, fn) { return fn() }, register(_options, view) { View = view; return () => {} } })
  const view = { watch() {
    opens++
    const controller = new AbortController(); controllers.push(controller)
    return { dispose: async () => controller.abort(), async *[Symbol.asyncIterator]() { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })) } }
  } }
  ctx.provide('remote', { $mount: async () => () => {}, perseCuaView: view })
  ctx.provide('remote.perseCuaView', view)
  const plugin = ctx.plugin({ name: 'preview-client-test', inject: client.inject, apply: client.apply })
  await plugin.await()
  View({ t: key => key, useSessions: selector => selector({ byId: { fixture: { id: 'fixture', retainedBy: { mainView: 1 } } } }) })
  for (let i = 0; i < 100 && opens === 0; i++) await pause(10)
  assert.equal(opens, 1)
  controllers[0].abort()
  for (let i = 0; i < 150 && opens < 2; i++) await pause(10)
  assert.equal(opens, 2)
  for (const cleanup of effects.reverse()) cleanup()
  await plugin.dispose()
  delete globalThis.__perseTestReact
  await pause(1100)
  assert.equal(opens, 2)
})
