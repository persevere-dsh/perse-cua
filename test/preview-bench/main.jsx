import React from 'react'
import { createRoot } from 'react-dom/client'
import { apply } from '../../packages/perse-cua/client/index.jsx'
import { createPreviewFixture } from './state.mjs'

const h = React.createElement
const makeImage = (title, frame, width, height) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = { Red: '#d35a52', Green: '#43a864', Blue: '#517dc5' }[title]; ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#fff'; ctx.font = `${Math.max(12, Math.min(28, width / 9))}px sans-serif`; ctx.fillText(`${title} · ${frame}`, 12, Math.min(height - 12, 42))
  return canvas.toDataURL('image/png')
}
const fixture = createPreviewFixture(makeImage)
let View
const service = { watch: session => fixture.watch(session), dismiss: (session, id) => fixture.dismiss(session, id) }
const child = { remote: { perseCuaView: service }, on: () => () => {}, slots: { inject: (_name, fn) => fn(), register: (_options, view) => { View = view; return () => {} } } }
// This host supplies only the plugin services used by the preview component.
const ctx = {
  locale: { register: () => () => {} },
  effect(fn) {
    const value = fn()
    if (!value?.next) return value
    const cleanups = []
    for (const cleanup of value) if (typeof cleanup === 'function') cleanups.push(cleanup)
    return async () => { for (const cleanup of cleanups.reverse()) await cleanup() }
  },
  plugin: () => ({ await: async () => {}, dispose: async () => {} }),
  inject: (_dependencies, fn) => { const dispose = fn(child); return { await: async () => {}, dispose } },
}
await apply(ctx)
const labels = { close: 'Close preview', expand: 'Expand', collapse: 'Collapse', waiting: 'Waiting for screenshot', failed: 'Operation failed', window: 'Window', captured: 'Captured', position: 'Action position', unavailable: 'Screenshot unavailable', windowUnavailable: 'Window unavailable', working: 'Working', get_window_state: 'View window', other: 'Action', switchTo: 'Switch to', issues: 'Preview status issues' }
const useSessions = selector => selector({ byId: { bench: { id: 'bench', retainedBy: { mainView: 1 } } } })
function Bench() {
  const [selected, setSelected] = React.useState('bench/app/1')
  const [failure, setFailure] = React.useState(false)
  return h(React.Fragment, null,
    h('main', { role: 'region', 'aria-label': 'Preview test controls', tabIndex: 0 }, h('h1', null, 'Preview test bench'),
      h('label', null, 'Window ', h('select', { value: selected, onChange: e => setSelected(e.target.value) }, ['Red', 'Green', 'Blue'].map((name, i) => h('option', { key: name, value: `bench/app/${i + 1}` }, name)))),
      h('div', { className: 'buttons' }, h('button', { onClick: () => fixture.frame(selected) }, 'Next frame'), h('button', { onClick: () => fixture.resize(selected) }, 'Change size'), h('button', { onClick: () => fixture.reset() }, 'Restore three windows')),
      h('label', { className: 'failure' }, h('input', { type: 'checkbox', checked: failure, onChange: e => { setFailure(e.target.checked); fixture.setFailure(e.target.checked) } }), ' Fail close requests')),
    h(View, { t: key => labels[key] ?? key, useSessions }))
}
createRoot(document.getElementById('root')).render(h(Bench))
