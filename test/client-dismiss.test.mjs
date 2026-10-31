import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'

const source = readFileSync(new URL('../packages/perse-cua/client/index.jsx', import.meta.url), 'utf8')
  .replace("import React, { useEffect, useRef, useState } from 'react'", 'const { React, useEffect, useRef, useState } = globalThis.__perseDismissReact')
  .replace("import remote from '../lib/typert.remote-client.js'", 'const remote = {}')

test('closing a preview accepts a void result and reports a rejected dismissal', async () => {
  const hooks = []; const cleanups = []; let cursor = 0
  globalThis.__perseDismissReact = {
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value }] },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial } },
    useEffect(fn) { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } },
  }
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const ctx = new Context(); let View; let reject = false; const calls = []
  const controller = new AbortController()
  const service = {
    watch() { return { dispose: async () => controller.abort(), async *[Symbol.asyncIterator]() { yield [{ id: 'session/a/1', title: 'First', action: 'read', image: 'data:image/png;base64,AAAA' }, { id: 'session/a/2', title: 'Second', action: 'read', image: 'data:image/png;base64,BBBB' }]; await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })) } } },
    async dismiss(session, id) { calls.push([session, id]); if (reject) throw new Error('offline') },
  }
  ctx.provide('locale', { register() { return () => {} } })
  ctx.provide('slots', { inject(_name, fn) { return fn() }, register(_options, view) { View = view; return () => {} } })
  ctx.provide('remote', { $mount: async () => () => {}, perseCuaView: service })
  ctx.provide('remote.perseCuaView', service)
  const plugin = ctx.plugin({ name: 'preview-dismiss-test', inject: client.inject, apply: client.apply }); await plugin.await()
  const render = () => { cursor = 0; return View({ t: key => key, useSessions: select => select({ byId: { session: { id: 'session', retainedBy: { mainView: 1 } } } }) }) }
  const find = (node, predicate) => { if (!node || typeof node !== 'object') return undefined; if (predicate(node)) return node; for (const child of node.children ?? []) { for (const nested of Array.isArray(child) ? child : [child]) { const result = find(nested, predicate); if (result) return result } } }
  render(); await pause(20)
  let tree = render()
  await find(tree, node => node.props.className === 'cua-control' && node.props.title === 'close').props.onClick()
  tree = render()
  assert.deepEqual(calls, [['session', 'session/a/1']])
  assert.equal(find(tree, node => node.props.className?.startsWith('cua-warning')), undefined)
  reject = true
  await find(tree, node => node.props.className === 'cua-control' && node.props.title === 'close').props.onClick()
  tree = render()
  assert.ok(find(tree, node => node.props.className?.startsWith('cua-warning')))
  for (const cleanup of cleanups.reverse()) cleanup()
  await plugin.dispose(); delete globalThis.__perseDismissReact
})
