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
    .replace("import theme from '../cursor-theme.json'", `const theme = ${await readFile(new URL('../packages/perse-cua/cursor-theme.json', import.meta.url), 'utf8')}`)
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const fixture = createPreviewFixture(() => 'data:image/png;base64,AAAA')
  let View, cleanup
  const child = { remote: { perseCuaView: fixture }, on: () => () => {}, slots: { inject: (_name, fn) => fn(), register: (options, view) => { if (options.id === 'perse-cua.driving') View = view; return () => {} } } }
  const ctx = {
    locale: { register: () => () => {} },
    effect(fn) { const value = fn(); if (!value?.next) return value; const disposers = [...value].filter(x => typeof x === 'function'); cleanup = async () => { for (const dispose of disposers.reverse()) await dispose() }; return cleanup },
    plugin: () => ({ await: async () => {}, dispose: async () => {} }),
    inject: (_deps, fn) => ({ await: async () => {}, dispose: fn(child) }),
  }
  await client.apply(ctx)
  let session = 'bench'
  const useSessions = select => select({ byId: { [session]: { id: session, retainedBy: { mainView: 1 } } } })
  const element = () => React.createElement(View, { t: key => key, useSessions })
  let root
  try {
    await act(async () => { root = TestRenderer.create(element()) })
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
    await act(async () => { fixture.addFourth() })
    assert.equal(root.root.findAllByProps({ className: 'cua-back' }).length, 2)
    await act(async () => { fixture.status('bench/app/1', 'offscreen') })
    assert.equal(root.root.findAllByProps({ className: 'cua-warning-button' }).length, 1)
    assert.equal(root.root.findAllByProps({ className: 'cua-preview' }).length, 1)
    await act(async () => { fixture.status('bench/app/1', 'failed') })
    assert.equal(root.root.findAllByProps({ className: 'cua-preview' }).length, 0)
    const placeholder = () => root.root.findAll(node => node.props.style?.placeItems === 'center')[0]
    assert.deepEqual(placeholder().children, ['unavailable'])
    await act(async () => { fixture.status('bench/app/1', 'offscreen-empty') })
    assert.deepEqual(placeholder().children, ['windowHidden'])
    await act(async () => { fixture.status('bench/app/1', 'discovery') })
    assert.equal(root.root.findAllByProps({ className: 'cua-preview' }).length, 1)
    assert.equal(root.root.findAllByProps({ className: 'cua-warning-button' }).length, 1)
    await act(async () => { fixture.status('bench/app/1', 'discovery-empty') })
    assert.deepEqual(placeholder().children, ['discoveryUnavailable'])
    await act(async () => { fixture.status('bench/app/1', 'offscreen-discovery') })
    let detail = root.root.findByProps({ id: 'cua-warning-detail' })
    assert.match(detail.children[0].children.join(''), /discoveryUnavailable · windowUnavailable/)
    await act(async () => { fixture.status('bench/app/1', 'offscreen') })
    detail = root.root.findByProps({ id: 'cua-warning-detail' })
    assert.match(detail.children[0].children.join(''), /windowUnavailable/)
    assert.doesNotMatch(detail.children[0].children.join(''), /discoveryUnavailable/)
    await act(async () => { fixture.status('bench/app/1', 'failed-discovery') })
    detail = root.root.findByProps({ id: 'cua-warning-detail' })
    assert.match(detail.children[0].children.join(''), /discoveryUnavailable · unavailable/)
    assert.deepEqual(placeholder().children, ['discoveryUnavailable'])
    await act(async () => { fixture.status('bench/app/1', 'waiting') })
    assert.deepEqual(placeholder().children, ['waiting'])
    await act(async () => { fixture.status('bench/app/1', 'ok') })
    assert.equal(root.root.findAllByProps({ className: 'cua-preview' }).length, 1)
    assert.equal(root.root.findAllByProps({ className: 'cua-warning-button' }).length, 0)
    await act(async () => { session = 'other'; root.update(element()) })
    assert.equal(section().props['aria-label'], 'Purple')
    await act(async () => { fixture.disconnect('other') })
    assert.equal(root.root.findAllByType('section').length, 0)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
    assert.equal(section().props['aria-label'], 'Purple')
  } finally {
    if (root) await act(async () => root.unmount())
    await cleanup()
    delete globalThis.__previewReact
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
  }
})

test('preview immediately clears removed frames during action animation and retains normal transitions', async () => {
  globalThis.__previewReact = React
  const source = (await readFile(new URL('../packages/perse-cua/client/index.jsx', import.meta.url), 'utf8'))
    .replace("import React, { useEffect, useRef, useState } from 'react'", 'const React = globalThis.__previewReact; const { useEffect, useRef, useState } = React')
    .replace("import remote from '../lib/typert.remote-client.js'", 'const remote = {}')
    .replace("import theme from '../cursor-theme.json'", `const theme = ${await readFile(new URL('../packages/perse-cua/cursor-theme.json', import.meta.url), 'utf8')}`) + '\nexport { PreviewImage }\n'
  const { PreviewImage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const original = { id: 'a/app/1', title: 'One', action: 'click', image: 'data:image/png;base64,AAAA', point: { x: .2, y: .3 } }
  const element = item => React.createElement(PreviewImage, { key: item.id, item, selected: false, t: key => key, toggle() {} })
  let root
  try {
    await act(async () => { root = TestRenderer.create(element(original)) })
    assert.equal(root.root.findByType('img').props.src, original.image)
    await act(async () => { root.update(element({ ...original, point: undefined, image: 'data:image/png;base64,BBBB' })) })
    assert.equal(root.root.findByType('img').props.src, 'data:image/png;base64,BBBB', 'screenshots refresh independently of cursor feedback')
    await act(async () => { root.update(element({ id: original.id, title: 'One', action: 'click', previewUnavailable: true })) })
    assert.equal(root.root.findAllByType('img').length, 0, 'permission failure must clear the frame immediately')
    assert.deepEqual(root.root.findAll(node => node.props.style?.placeItems === 'center')[0].children, ['unavailable'])
    await act(async () => { root.update(element({ id: original.id, title: 'One', action: 'click', previewUnavailable: true, previewIssue: 'screenRecording' })) })
    assert.deepEqual(root.root.findAll(node => node.props.style?.placeItems === 'center')[0].children, ['screenRecording'])
    await act(async () => { root.update(element(original)) })
    assert.equal(root.root.findAllByType('img').length, 1)
    await act(async () => { root.update(null) })
    assert.equal(root.toJSON(), null, 'closing the window must remove the animated frame immediately')
    const other = { id: 'a/app/2', title: 'Two', action: 'getState', image: 'data:image/png;base64,CCCC' }
    await act(async () => { root.update(element(other)) })
    assert.equal(root.root.findByType('img').props.src, other.image)
  } finally { if (root) await act(async () => root.unmount()); delete globalThis.__previewReact }
})

test('reduced-motion preference places the cursor at its final point with a brief static click cue', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }
  globalThis.__previewReact = React
  const source = (await readFile(new URL('../packages/perse-cua/client/index.jsx', import.meta.url), 'utf8'))
    .replace("import React, { useEffect, useRef, useState } from 'react'", 'const React = globalThis.__previewReact; const { useEffect, useRef, useState } = React')
    .replace("import remote from '../lib/typert.remote-client.js'", 'const remote = {}')
    .replace("import theme from '../cursor-theme.json'", `const theme = ${await readFile(new URL('../packages/perse-cua/cursor-theme.json', import.meta.url), 'utf8')}`) + '\nexport { Cursor }\n'
  const { Cursor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const motion = { sequence: 1, color: '#5EC0E8', phase: 'click', elapsedMs: 0, clickElapsedMs: 0, trajectory: { samples: [{ t: 0, x: .1, y: .2, angle: 0 }, { t: .5, x: .8, y: .9, angle: 0 }], arrivalT: .5 } }
  let root
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(Cursor, { motion, t: key => key })) })
    const marker = root.root.findByProps({ className: 'cua-click-point' })
    assert.equal(marker.props.style.left, '80%')
    assert.equal(marker.props.style.top, '90%')
    assert.equal(root.root.findByType('svg').props.style.transform, 'rotate(0rad) scale(0.93)')
    assert.equal(root.root.findAllByType('path').length, 15, 'click cue remains visible without animation')
  } finally {
    if (root) await act(async () => root.unmount())
    delete globalThis.__previewReact
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
  }
})
