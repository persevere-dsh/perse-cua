import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createPreviewFixture } from './preview-bench/state.mjs'

test('real preview component switches, expands, closes and reports a failed close', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.__previewReact = React
  const source = (await readFile(new URL('../packages/perse-cua/client/index.jsx', import.meta.url), 'utf8'))
    .replace("import React, { useEffect, useRef, useState } from 'react'", 'const React = globalThis.__previewReact; const { useEffect, useRef, useState } = React')
    .replace("import remote from '../lib/typert.remote-client.js'", 'const remote = {}')
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const fixture = createPreviewFixture(() => 'data:image/png;base64,AAAA')
  let View, cleanup
  const child = { remote: { perseCuaView: fixture }, on: () => () => {}, slots: { inject: (_name, fn) => fn(), register: (_options, view) => { View = view; return () => {} } } }
  const ctx = {
    locale: { register: () => () => {} },
    effect(fn) { const value = fn(); if (!value?.next) return value; const disposers = [...value].filter(x => typeof x === 'function'); cleanup = async () => { for (const dispose of disposers.reverse()) await dispose() }; return cleanup },
    plugin: () => ({ await: async () => {}, dispose: async () => {} }),
    inject: (_deps, fn) => ({ await: async () => {}, dispose: fn(child) }),
  }
  await client.apply(ctx)
  const useSessions = select => select({ byId: { bench: { id: 'bench', retainedBy: { mainView: 1 } } } })
  let root
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(View, { t: key => key, useSessions })) })
    const section = () => root.root.findByType('section')
    const control = title => root.root.findAllByType('button').find(button => button.props.title === title)
    assert.equal(section().props['aria-label'], 'Red')
    await act(async () => { root.root.findAllByProps({ className: 'cua-back' }).find(button => button.props.title === 'Green').props.onClick() })
    assert.equal(section().props['aria-label'], 'Green')
    await act(async () => { control('expand').props.onClick() })
    assert.equal(control('collapse').props.title, 'collapse')
    fixture.setFailure(true)
    await act(async () => { await control('close').props.onClick() })
    assert.equal(fixture.snapshot().length, 3)
    assert.equal(root.root.findAllByProps({ className: 'cua-warning-button' }).length, 1)
    fixture.setFailure(false)
    await act(async () => { await control('close').props.onClick() })
    assert.deepEqual(fixture.snapshot().map(item => item.title), ['Red', 'Blue'])
    assert.equal(root.root.findAllByProps({ className: 'cua-warning-button' }).length, 0)
  } finally {
    if (root) await act(async () => root.unmount())
    await cleanup()
    delete globalThis.__previewReact
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
  }
})
