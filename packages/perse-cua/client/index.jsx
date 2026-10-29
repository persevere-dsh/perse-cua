import React, { useEffect, useRef, useState } from 'react'
import remote from '../lib/typert.remote-client.js'

export const inject = ['remote', 'slots', 'locale']
const h = React.createElement
const labels = {
  zh: { close: '关闭预览', expand: '放大窗口', collapse: '收起', waiting: '等待截图', failed: '操作失败', window: '窗口', captured: '上次截图', position: '动作位置', unavailable: '截图不可用', windowUnavailable: '窗口不可见 · 上次画面', working: '正在操作', click: '点击', move_cursor: '移动光标', get_window_state: '查看窗口', other: '操作', switchTo: '切换到窗口', issues: '预览状态异常' },
  en: { close: 'Close preview', expand: 'Expand window', collapse: 'Collapse', waiting: 'Waiting for screenshot', failed: 'Action failed', window: 'Window', captured: 'Last screenshot', position: 'Action position', unavailable: 'Screenshot unavailable', windowUnavailable: 'Window not visible · last image', working: 'Working', click: 'Click', move_cursor: 'Move cursor', get_window_state: 'View window', other: 'Action', switchTo: 'Switch to window', issues: 'Preview status issues' },
}
const icon = (name) => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: name === 'close' ? 'M18 6 6 18M6 6l12 12' : name === 'expand' ? 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7' : name === 'next' ? 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7' : 'M4 14h6v6M10 14l-6 6M20 10h-6V4M14 10l6-6' }))
const validImage = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)

function PreviewImage({ item, selected, t, toggle }) {
  const [frame, setFrame] = useState(item)
  const timer = useRef(null)
  const latest = useRef(item)
  useEffect(() => {
    latest.current = item
    if (item.working && item.action !== 'get_window_state') {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setFrame(item)
      return
    }
    if (item.point) {
      if (timer.current) clearTimeout(timer.current)
      setFrame(item)
      timer.current = setTimeout(() => { timer.current = null; setFrame(latest.current.point ? { ...latest.current, point: undefined } : latest.current) }, 900)
    } else if (!timer.current) setFrame(item)
  }, [item])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!validImage(frame.image)) return h('div', { style: { padding: 12 } }, t('waiting'))
  const point = frame.point && Number.isFinite(frame.point.x) && Number.isFinite(frame.point.y) && frame.point.x >= 0 && frame.point.x <= 1 && frame.point.y >= 0 && frame.point.y <= 1
  return h('button', { className: 'cua-preview', type: 'button', onClick: toggle, 'aria-label': `${selected ? t('collapse') : t('expand')} · ${frame.title}${frame.capturedAt ? ` · ${t('captured')} ${new Date(frame.capturedAt).toLocaleTimeString()}` : ''}`, style: { display: 'block', width: '100%', padding: 0, border: 0, borderRadius: 9, overflow: 'hidden', background: 'transparent', cursor: selected ? 'zoom-out' : 'zoom-in' } },
    h('span', { style: { display: 'inline-block', maxWidth: '100%', position: 'relative', verticalAlign: 'top', overflow: 'hidden', margin: '0 auto', boxSizing: 'border-box' } },
      h('img', { src: frame.image, alt: frame.title, style: { display: 'block', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: selected ? 'calc(100vh - 250px)' : 160, objectFit: 'contain' } }),
      point && h('span', { style: { position: 'absolute', top: 4, right: 4, borderRadius: 4, padding: '2px 5px', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-brand-text, #222)', border: '1px solid var(--dsw-alias-border-l3, #888)', font: '11px system-ui', pointerEvents: 'none' } }, t('position')),
      point && h('span', { className: 'cua-click-point', title: t('position'), 'aria-label': t('position'), style: { position: 'absolute', left: `${frame.point.x * 100}%`, top: `${frame.point.y * 100}%`, width: 25, height: 30, transform: 'translate(-2px,-2px)', filter: 'drop-shadow(0 2px 5px rgba(40,45,55,.45))', pointerEvents: 'none' } },
        h('svg', { width: 25, height: 30, viewBox: '0 0 20 24', 'aria-hidden': true }, h('path', { d: 'M2 1v17l4.2-4 3.2 7 3-1.4-3.2-7 6-.3z', fill: '#31343b', stroke: 'white', strokeWidth: 1.5, strokeLinejoin: 'round' })))))
}

export async function apply(ctx) {
  let mount
  let scope
  const owner = ctx.effect(function* () {
    yield ctx.effect(() => ctx.locale.register('perse-cua', labels))
    mount = ctx.plugin({ inject: ['remote'], async apply(child) { await child.remote.$mount(remote) } })
    yield mount.dispose
    scope = ctx.inject(['remote.perseCuaView'], child => {
      let windows = []
      let stream
      let closed = false
      let sequence = 0
      let retry
      const listeners = new Set()
      const tasks = new Set()
      const errors = []
      const track = promise => { const task = Promise.resolve(promise).catch(error => { errors.push(error); console.error('[perse-cua] stream error', error) }).finally(() => tasks.delete(task)); tasks.add(task) }
      const retire = old => { if (old) { try { track(old.dispose()) } catch (error) { errors.push(error) } } }
      const open = () => {
        if (closed) return
        if (retry) clearTimeout(retry)
        retry = undefined
        retire(stream)
        const generation = ++sequence
        try { stream = child.remote.perseCuaView.watch() } catch (error) { console.error('[perse-cua] stream open failed', error); windows = []; for (const notify of listeners) notify(); retry = setTimeout(open, 1000); return }
        const active = stream
        track((async () => {
          try { for await (const next of active) { if (closed || generation !== sequence) break; windows = next; for (const notify of listeners) notify() } }
          finally {
            if (!closed && generation === sequence) {
              stream = undefined
              windows = []
              for (const notify of listeners) notify()
              retire(active)
              retry = setTimeout(open, 1000)
            }
          }
        })())
      }
      const stopReset = child.on('connection/reset', open)
      function View({ t }) {
        const [items, setItems] = useState(windows)
        const [selected, setSelected] = useState(null)
        const [active, setActive] = useState(null)
        const [error, setError] = useState('')
        const [warningDismissed, setWarningDismissed] = useState(false)
        const root = useRef(null)
        const previousSelection = useRef(null)
        const switching = useRef(false)
        useEffect(() => { const update = () => setItems(windows); listeners.add(update); update(); return () => listeners.delete(update) }, [])
        useEffect(() => { if (selected && !items.some(item => item.id === selected)) setSelected(null) }, [items, selected])
        useEffect(() => {
          if (selected) (root.current?.querySelector('[role=tab][aria-selected=true]') ?? root.current?.querySelector('.cua-control'))?.focus()
          else if (previousSelection.current) {
            const card = [...(root.current?.querySelectorAll('[data-cua-id]') ?? [])].find(node => node.dataset.cuaId === previousSelection.current)
            card?.querySelector('.cua-control')?.focus()
          }
          previousSelection.current = selected
        }, [selected])
        useEffect(() => { if (switching.current) { switching.current = false; root.current?.querySelector('.cua-preview')?.focus() } }, [active])
        useEffect(() => { if (!selected) return; const key = event => { if (event.key === 'Escape') setSelected(null) }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [selected])
        const close = async id => { try { const result = await child.remote.perseCuaView.dismiss(id); setError(result.ok ? '' : t('failed')) } catch { setError(t('failed')) } }
        const item = items.find(row => row.id === (selected || active)) ?? items[0]
        const behind = items.filter(row => row.id !== item?.id)
        const problems = items.filter(row => row.failed || row.previewUnavailable || row.windowUnavailable)
        const exceptional = problems.length > 0 || error
        return h('div', { className: 'perse-cua-root', ref: root, style: { position: 'fixed', right: 12, top: 72, width: selected ? 'min(540px, calc(100vw - 24px))' : 'min(260px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', zIndex: 1200, pointerEvents: 'auto' } },
          h('style', null, `.perse-cua-root button{font:inherit}.perse-cua-root .cua-control{display:grid;place-items:center;width:28px;height:28px;border:2px solid transparent;border-radius:50%;color:#fff;background:rgba(24,24,28,.58);background-clip:padding-box;cursor:pointer}.perse-cua-root .cua-chrome{display:flex;gap:4px;position:absolute;z-index:3;top:6px;left:6px}.perse-cua-root .cua-warning{position:absolute;top:6px;right:6px;z-index:4}.perse-cua-root .cua-warning-button{width:28px;height:28px;border:2px solid transparent;border-radius:50%;background:#9a5700;background-clip:padding-box;color:#fff;font-weight:500;cursor:pointer}.perse-cua-root .cua-warning-detail{display:none;position:fixed;right:16px;top:104px;width:min(300px,calc(100vw - 32px));max-height:calc(100vh - 120px);overflow-y:auto;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3,#888);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-text,#222);box-shadow:0 4px 18px rgba(0,0,0,.16);line-height:1.4;overflow-wrap:anywhere}.perse-cua-root .cua-warning:not(.dismissed):focus-within .cua-warning-detail{display:block}@media(hover:hover){.perse-cua-root .cua-warning:not(.dismissed):hover .cua-warning-detail{display:block}}.perse-cua-root .cua-tab{border:0;border-radius:6px;padding:6px 9px;background:transparent;color:inherit;white-space:nowrap;max-width:70%;overflow:hidden;text-overflow:ellipsis;flex:none;cursor:pointer}.perse-cua-root .cua-tab[aria-selected=true]{background:var(--dsw-alias-button-ghost-active-fill,rgba(128,128,128,.22));font-weight:500}.perse-cua-root button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);outline-offset:-2px}@media(hover:hover){.perse-cua-root .cua-chrome{opacity:0}.perse-cua-root section:hover .cua-chrome,.perse-cua-root section:focus-within .cua-chrome{opacity:1}.perse-cua-root .cua-control:hover{background:rgba(24,24,28,.8)}}@keyframes cua-click-pulse{0%{filter:drop-shadow(0 0 0 rgba(80,85,95,.55))}55%{filter:drop-shadow(0 0 8px rgba(80,85,95,.55))}100%{filter:drop-shadow(0 0 0 transparent)}}.perse-cua-root .cua-click-point{animation:cua-click-pulse .7s ease-out}@media(prefers-reduced-motion:reduce){.perse-cua-root .cua-click-point{animation:none}}`),
          item && h('div', { style: { position: 'relative', paddingBottom: !selected ? behind.length * 56 : 0 } },
            !selected && behind.map((row, index) => h('button', { key: row.id, className: 'cua-back', type: 'button', onClick: () => { switching.current = true; setActive(row.id) }, 'aria-label': `${t('switchTo')} ${row.title}`, title: row.title, style: { position: 'absolute', left: 0, right: 0, top: (index + 1) * 56, bottom: (behind.length - index - 1) * 56, zIndex: behind.length - index, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l3, #888)', background: 'var(--dsw-alias-bg-layer-1,#fff)', backgroundImage: validImage(row.image) ? `url(${row.image})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', boxShadow: '0 4px 18px rgba(0,0,0,.12)', cursor: 'pointer' } })),
            h('section', { 'data-cua-id': item.id, 'aria-label': item.title, style: { position: 'relative', zIndex: behind.length + 1, background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-brand-text, #222)', border: '1px solid var(--dsw-alias-border-l3, #888)', borderRadius: 10, boxShadow: '0 4px 18px rgba(0,0,0,.12)', font: '12px system-ui' } },
              h('div', { className: 'cua-chrome' }, h('button', { className: 'cua-control', type: 'button', onClick: () => close(item.id), title: t('close'), 'aria-label': t('close') }, icon('close')), h('button', { className: 'cua-control', type: 'button', onClick: () => { setActive(item.id); setSelected(selected ? null : item.id) }, title: selected ? t('collapse') : t('expand'), 'aria-label': selected ? t('collapse') : t('expand') }, icon(selected ? 'collapse' : 'expand'))),
              selected && items.length > 1 && h('nav', { role: 'tablist', 'aria-label': t('window'), style: { display: 'flex', gap: 4, overflowX: 'auto', padding: '40px 8px 8px', maxWidth: '100%' } }, items.map(row => h('button', { className: 'cua-tab', key: row.id, type: 'button', role: 'tab', 'aria-selected': row.id === item.id, onClick: () => { setActive(row.id); setSelected(row.id) }, onKeyDown: event => { const index = items.findIndex(entry => entry.id === row.id); const n = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1; if (n >= 0) { event.preventDefault(); setActive(items[n].id); setSelected(items[n].id) } }, title: row.title }, row.title.split(' · ').at(-1)))),
              h(PreviewImage, { key: item.id, item, selected, t, toggle: () => { setActive(item.id); setSelected(selected ? null : item.id) } }),
              exceptional && h('div', { className: `cua-warning${warningDismissed ? ' dismissed' : ''}`, onMouseEnter: () => setWarningDismissed(false), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.querySelector('button')?.focus(); setWarningDismissed(true) } } }, h('button', { className: 'cua-warning-button', type: 'button', 'aria-label': t('issues'), 'aria-describedby': 'cua-warning-detail', onFocus: () => setWarningDismissed(false), onClick: () => setWarningDismissed(false) }, '!'), h('div', { className: 'cua-warning-detail', id: 'cua-warning-detail', role: 'region', 'aria-label': t('issues'), tabIndex: 0 }, problems.map(row => h('div', { key: row.id }, row.title, ' · ', row.failed ? t('failed') : '', row.failed && (row.windowUnavailable || row.previewUnavailable) ? ' · ' : '', row.windowUnavailable ? t('windowUnavailable') : row.previewUnavailable ? t('unavailable') : '', row.capturedAt ? ` · ${t('captured')} ${new Date(row.capturedAt).toLocaleTimeString()}` : '')), error && h('div', null, error))))))
      }
      const unregister = child.slots.inject('shell.overlay', () => child.slots.register({ name: 'shell.overlay', id: 'perse-cua.driving', locale: 'perse-cua' }, View))
      open()
      return async () => { closed = true; sequence++; if (retry) clearTimeout(retry); retire(stream); for (const dispose of [stopReset, unregister]) { try { dispose() } catch (error) { errors.push(error) } } listeners.clear(); await Promise.all([...tasks]); if (errors.length) throw new AggregateError(errors, '[perse-cua] cannot fully stop view') }
    })
    yield scope.dispose
  })
  try { await mount.await(); await scope.await() } catch (error) { await owner(); throw error }
}
