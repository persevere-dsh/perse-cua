import React, { useEffect, useRef, useState } from 'react'
import remote from '../lib/typert.remote-client.js'
import theme from '../cursor-theme.json'

export const inject = ['remote', 'slots', 'locale']
const h = React.createElement
const labels = {
  zh: { close: '关闭预览', expand: '放大窗口', collapse: '收起', waiting: '等待截图', failed: '操作失败', window: '窗口', captured: '上次截图', position: '动作位置', unavailable: '截图不可用', discoveryUnavailable: '无法获取窗口列表', windowUnavailable: '窗口不可见 · 上次画面', windowHidden: '窗口不可见', working: '正在操作', click: '点击', move_cursor: '移动光标', get_window_state: '查看窗口', other: '操作', switchTo: '切换到窗口', issues: '预览状态异常', completed: '任务已完成', stopped: '任务已停止', taskFailed: '任务失败', accessibility: '需要辅助功能权限', screenRecording: '需要录屏权限', connection: '原生连接不可用', busy: '截图暂忙', previewWindow: '目标窗口不可用' },
  en: { close: 'Close preview', expand: 'Expand window', collapse: 'Collapse', waiting: 'Waiting for screenshot', failed: 'Action failed', window: 'Window', captured: 'Last screenshot', position: 'Action position', unavailable: 'Screenshot unavailable', discoveryUnavailable: 'Window list unavailable', windowUnavailable: 'Window not visible · last image', windowHidden: 'Window not visible', working: 'Working', click: 'Click', move_cursor: 'Move cursor', get_window_state: 'View window', other: 'Action', switchTo: 'Switch to window', issues: 'Preview status issues', completed: 'Task completed', stopped: 'Task stopped', taskFailed: 'Task failed', accessibility: 'Accessibility permission required', screenRecording: 'Screen Recording permission required', connection: 'Native connection unavailable', busy: 'Screenshot busy', previewWindow: 'Target window unavailable' },
}
const icon = (name) => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: name === 'close' ? 'M18 6 6 18M6 6l12 12' : name === 'expand' ? 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7' : name === 'next' ? 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7' : 'M4 14h6v6M10 14l-6 6M20 10h-6V4M14 10l6-6' }))
const backdrop = image => ({ position: 'absolute', inset: 0, backgroundImage: `url(${image})`, backgroundPosition: 'center', backgroundSize: 'cover', filter: 'blur(18px)', transform: 'scale(1.2)', opacity: 0.25, pointerEvents: 'none' })
const validImage = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)

const cursorPath = theme.vertices.map(([point, , out], index, vertices) => {
  const next = vertices[(index + 1) % vertices.length]
  return `${index === 0 ? `M${point[0]} ${point[1]} ` : ''}C${point[0] + out[0]} ${point[1] + out[1]} ${next[0][0] + next[1][0]} ${next[0][1] + next[1][1]} ${next[0][0]} ${next[0][1]}`
}).join(' ') + ' Z'
const sampleMotion = (motion, elapsedMs) => {
  const samples = motion.trajectory.samples, t = elapsedMs / 1000
  if (!samples.length) return null
  let next = samples.findIndex(sample => sample.t >= t)
  if (next <= 0) return next === 0 ? samples[0] : samples[samples.length - 1]
  const a = samples[next - 1], b = samples[next], f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)))
  const delta = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle))
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: a.angle + delta * f }
}
const clickScale = elapsedMs => {
  const frame = elapsedMs * theme.click.fps / 1000, frames = theme.click.frames
  const index = frames.findIndex(([time]) => time >= frame)
  if (index <= 0) return (index === 0 ? frames[0][1] : frames[frames.length - 1][1]) / 100
  const [t0, v0] = frames[index - 1], [t1, v1] = frames[index]
  return (v0 + (v1 - v0) * (frame - t0) / (t1 - t0)) / 100
}
function Cursor({ motion, point, t }) {
  const [elapsed, setElapsed] = useState(motion?.elapsedMs ?? 0)
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
  useEffect(() => {
    const query = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined
    if (!query) return
    const update = () => setReduced(query.matches)
    update(); query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  useEffect(() => {
    if (!motion) return
    const started = performance.now(), initial = motion.elapsedMs
    let timer, stopped = false
    const clickEnd = motion.clickElapsedMs === undefined ? 0 : motion.elapsedMs + Math.max(0, 1000 * theme.click.frames.at(-1)[0] / theme.click.fps - motion.clickElapsedMs)
    const end = reduced ? motion.elapsedMs + (motion.phase === 'click' ? Math.max(0, theme.click.cueStyle.reducedDurationMs - (motion.clickElapsedMs ?? 0)) : 0) : Math.max((motion.trajectory.samples.at(-1)?.t ?? 0) * 1000, clickEnd)
    const tick = () => { if (stopped) return; const current = initial + performance.now() - started; setElapsed(current); if (current < end) timer = setTimeout(tick, 16) }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [motion?.sequence, reduced])
  const sample = motion ? reduced ? motion.trajectory.samples.at(-1) : sampleMotion(motion, elapsed) : point && { ...point, angle: 0 }
  if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return null
  const color = motion?.color ?? theme.color
  const clickElapsed = motion?.clickElapsedMs === undefined ? elapsed : motion.clickElapsedMs + Math.max(0, elapsed - motion.elapsedMs)
  const clicking = motion?.phase === 'click' && clickElapsed < (reduced ? theme.click.cueStyle.reducedDurationMs : 1000 * theme.click.frames.at(-1)[0] / theme.click.fps)
  const clickFrame = reduced ? theme.click.cueStyle.reducedFrame : clickElapsed * theme.click.fps / 1000
  const scale = clicking ? clickScale(reduced ? theme.click.cueStyle.reducedFrame * 1000 / theme.click.fps : clickElapsed) : 1
  const cueOpacity = Math.min(1, clickFrame / theme.click.cueStyle.fadeInFrames, Math.max(0, (theme.click.frames.at(-1)[0] - clickFrame) / theme.click.cueStyle.fadeOutFrames))
  const cueScale = theme.click.cueStyle.startScale + (theme.click.cueStyle.endScale - theme.click.cueStyle.startScale) * clickFrame / theme.click.frames.at(-1)[0]
  return h('span', { className: 'cua-click-point', title: t('position'), 'aria-label': t('position'), style: { position: 'absolute', left: `${sample.x * 100}%`, top: `${sample.y * 100}%`, width: theme.size, height: theme.size, transform: `translate(${-theme.hotspot[0] / theme.viewBox * 100}%, ${-theme.hotspot[1] / theme.viewBox * 100}%)`, pointerEvents: 'none' } },
    h('svg', { width: theme.size, height: theme.size, viewBox: `0 0 ${theme.viewBox} ${theme.viewBox}`, 'aria-hidden': true, style: { overflow: 'visible', transformOrigin: `${theme.hotspot[0] / theme.viewBox * 100}% ${theme.hotspot[1] / theme.viewBox * 100}%`, transform: `rotate(${sample.angle}rad) scale(${scale})` } },
      theme.glow.map(([width, opacity]) => h('path', { key: width, d: cursorPath, fill: 'none', stroke: color, strokeWidth: width, opacity, strokeLinejoin: 'round' })),
      h('path', { d: cursorPath, fill: color, stroke: theme.stroke, strokeWidth: theme.strokeWidth, strokeLinejoin: 'round' }),
      clicking && h('g', { opacity: cueOpacity, transform: `translate(${theme.hotspot[0]} ${theme.hotspot[1]}) scale(${cueScale}) translate(${-theme.hotspot[0]} ${-theme.hotspot[1]})` }, theme.click.cue.flatMap(([a, b], index) => [h('path', { key: `white-${index}`, d: `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`, fill: 'none', stroke: theme.stroke, strokeWidth: theme.click.cueStyle.outerWidth, strokeLinecap: 'round' }), h('path', { key: `color-${index}`, d: `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`, fill: 'none', stroke: color, strokeWidth: theme.click.cueStyle.innerWidth, strokeLinecap: 'round' })]))))
}
function PreviewImage({ item, selected, t, toggle }) {
  const [point, setPoint] = useState(item.point)
  useEffect(() => {
    setPoint(item.point)
    if (!item.point) return
    const timer = setTimeout(() => setPoint(undefined), 900)
    return () => clearTimeout(timer)
  }, [item.point])
  if (!validImage(item.image)) return h('button', { className: 'cua-placeholder', type: 'button', onClick: toggle, 'aria-label': `${selected ? t('collapse') : t('expand')} · ${item.title}`, style: { display: 'grid', placeItems: 'center', width: '100%', height: 'var(--cua-card-height)', border: 0, background: 'transparent', color: 'inherit', cursor: selected ? 'zoom-out' : 'zoom-in' } }, t(item.previewIssue ? item.previewIssue === 'window' ? 'previewWindow' : item.previewIssue : item.discoveryUnavailable ? 'discoveryUnavailable' : item.windowUnavailable ? 'windowHidden' : item.previewUnavailable ? 'unavailable' : 'waiting'))
  return h('button', { className: 'cua-preview', type: 'button', onClick: toggle, 'aria-label': `${selected ? t('collapse') : t('expand')} · ${item.title}${item.capturedAt ? ` · ${t('captured')} ${new Date(item.capturedAt).toLocaleTimeString()}` : ''}`, style: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 'var(--cua-card-height)', padding: 0, border: 0, borderRadius: 10, overflow: 'hidden', background: 'transparent', cursor: selected ? 'zoom-out' : 'zoom-in' } },
    h('span', { 'aria-hidden': true, style: backdrop(item.image) }),
    h('span', { style: { display: 'inline-block', maxWidth: '100%', minWidth: 0, position: 'relative', verticalAlign: 'top', overflow: 'hidden', margin: '0 auto', boxSizing: 'border-box' } },
      h('img', { src: item.image, alt: item.title, style: { display: 'block', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 'var(--cua-card-height)', objectFit: 'contain' } }),
      h(Cursor, { motion: item.motion, point, t })))
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
      let sessionId
      let retry
      const listeners = new Set()
      const tasks = new Set()
      const errors = []
      const track = promise => { const task = Promise.resolve(promise).catch(error => { errors.push(error); console.error('[perse-cua] stream error', error) }).finally(() => tasks.delete(task)); tasks.add(task) }
      const retire = old => { if (old) { try { track(old.dispose()) } catch (error) { errors.push(error) } } }
      const open = () => {
        if (closed || !sessionId) return
        if (retry) clearTimeout(retry)
        retry = undefined
        retire(stream)
        const generation = ++sequence
        try { stream = child.remote.perseCuaView.watch(sessionId) } catch (error) { console.error('[perse-cua] stream open failed', error); windows = []; for (const notify of listeners) notify(); retry = setTimeout(open, 1000); return }
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
      function View({ t, useSessions }) {
        const currentSession = useSessions(state => Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
        useEffect(() => {
          sessionId = currentSession
          sequence++; retire(stream); stream = undefined; windows = []; for (const notify of listeners) notify()
          if (currentSession) open()
          return () => { sessionId = undefined; sequence++; retire(stream); stream = undefined; windows = []; for (const notify of listeners) notify() }
        }, [currentSession])
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
        const close = async id => { try { await child.remote.perseCuaView.dismiss(currentSession, id); setError('') } catch { setError(t('failed')) } }
        const item = items.find(row => row.id === (selected || active)) ?? items[0]
        const behind = items.filter(row => row.id !== item?.id)
        const stack = n => `${n * 24}px`
        const stackX = n => `${Math.min(n * 24, 72)}px`
        const cardHeight = `min(${selected ? 332 : 160}px, calc((100vw - 96px) * 8 / 13), max(32px, calc(100vh - 96px)))`
        const problems = items.filter(row => row.failed || row.previewUnavailable || row.windowUnavailable || row.discoveryUnavailable)
        const exceptional = problems.length > 0 || error
        const problemText = row => [row.failed && t('failed'), row.discoveryUnavailable && t('discoveryUnavailable'), row.windowUnavailable && t(validImage(row.image) ? 'windowUnavailable' : 'windowHidden'), row.previewUnavailable && t('unavailable'), row.previewIssue && t(row.previewIssue === 'window' ? 'previewWindow' : row.previewIssue)].filter(Boolean).join(' · ')
        return h('div', { className: 'perse-cua-root', ref: root, style: { position: 'fixed', right: 4, top: 64, width: selected ? 'min(628px, calc(100vw - 8px))' : 'min(348px, calc(100vw - 8px))', maxHeight: 'calc(100vh - 80px)', padding: '8px 8px 20px', boxSizing: 'border-box', overflowY: 'auto', zIndex: 1200, pointerEvents: 'none' } },
          h('style', null, `.perse-cua-root button{font:inherit}.perse-cua-root .cua-control{display:grid;place-items:center;width:28px;height:28px;border:2px solid transparent;border-radius:50%;color:#fff;background:rgba(24,24,28,.58);background-clip:padding-box;cursor:pointer}.perse-cua-root .cua-chrome{display:flex;gap:4px;position:absolute;z-index:3;top:6px;left:6px}.perse-cua-root .cua-warning{position:absolute;top:6px;right:6px;z-index:4}.perse-cua-root .cua-warning-button{width:28px;height:28px;border:2px solid transparent;border-radius:50%;background:#9a5700;background-clip:padding-box;color:#fff;font-weight:500;cursor:pointer}.perse-cua-root .cua-warning-detail{display:none;position:fixed;right:16px;top:104px;width:min(300px,calc(100vw - 32px));max-height:calc(100vh - 120px);overflow-y:auto;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3,#888);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-text,#222);box-shadow:0 4px 18px rgba(0,0,0,.16);line-height:1.4;overflow-wrap:anywhere}.perse-cua-root .cua-warning:not(.dismissed):focus-within .cua-warning-detail{display:block}@media(hover:hover){.perse-cua-root .cua-warning:not(.dismissed):hover .cua-warning-detail{display:block}}.perse-cua-root button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);outline-offset:-2px}@media(hover:hover){.perse-cua-root .cua-chrome{opacity:0}.perse-cua-root section:hover .cua-chrome,.perse-cua-root section:focus-within .cua-chrome{opacity:1}.perse-cua-root .cua-control:hover{background:rgba(24,24,28,.8)}}`),
          item && h('div', { style: { position: 'relative', paddingBottom: stack(behind.length), '--cua-card-height': cardHeight } },
            behind.map((row, index) => h('button', { key: row.id, className: 'cua-back', type: 'button', onClick: () => { switching.current = true; setActive(row.id); if (selected) setSelected(row.id) }, 'aria-label': `${t('switchTo')} ${row.title}`, title: row.title, style: { position: 'absolute', right: stackX(index + 1), width: 'calc(100% - 72px)', height: 'var(--cua-card-height)', top: stack(index + 1), boxSizing: 'border-box', pointerEvents: 'auto', zIndex: behind.length - index, borderRadius: 10, border: 0, background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 90%, #777)', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,.16), 0 10px 28px rgba(0,0,0,.12)', cursor: 'pointer' } }, validImage(row.image) && h(React.Fragment, null, h('span', { 'aria-hidden': true, style: backdrop(row.image) }), h('span', { 'aria-hidden': true, style: { position: 'absolute', inset: 0, backgroundImage: `url(${row.image})`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' } })))),
            h('section', { 'data-cua-id': item.id, 'aria-label': item.title, style: { position: 'relative', marginLeft: 72, zIndex: behind.length + 1, overflow: 'hidden', pointerEvents: 'auto', background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 90%, #777)', color: 'var(--dsw-alias-brand-text, #222)', borderRadius: 10, boxShadow: '0 2px 8px rgba(0,0,0,.16), 0 10px 28px rgba(0,0,0,.12)', font: '12px system-ui' } },
              h('div', { className: 'cua-chrome' }, h('button', { className: 'cua-control', type: 'button', onClick: () => close(item.id), title: t('close'), 'aria-label': t('close') }, icon('close')), h('button', { className: 'cua-control', type: 'button', onClick: () => { setActive(item.id); setSelected(selected ? null : item.id) }, title: selected ? t('collapse') : t('expand'), 'aria-label': selected ? t('collapse') : t('expand') }, icon(selected ? 'collapse' : 'expand'))),
              h(PreviewImage, { key: item.id, item, selected, t, toggle: () => { setActive(item.id); setSelected(selected ? null : item.id) } }),
              item.activity && h('span', { role: 'status', style: { position: 'absolute', bottom: 6, left: 6, color: '#fff', background: 'rgba(24,24,28,.75)', padding: '3px 6px', borderRadius: 5 } }, t(item.activity === 'failed' ? 'taskFailed' : item.activity)),
              exceptional && h('div', { className: `cua-warning${warningDismissed ? ' dismissed' : ''}`, onMouseEnter: () => setWarningDismissed(false), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.querySelector('button')?.focus(); setWarningDismissed(true) } } }, h('button', { className: 'cua-warning-button', type: 'button', 'aria-label': t('issues'), 'aria-describedby': 'cua-warning-detail', onFocus: () => setWarningDismissed(false), onClick: () => setWarningDismissed(false) }, '!'), h('div', { className: 'cua-warning-detail', id: 'cua-warning-detail', role: 'region', 'aria-label': t('issues'), tabIndex: 0 }, problems.map(row => h('div', { key: row.id }, row.title, ' · ', problemText(row), row.capturedAt ? ` · ${t('captured')} ${new Date(row.capturedAt).toLocaleTimeString()}` : '')), error && h('div', null, error))))))
      }
      const unregister = child.slots.inject('shell.overlay', () => child.slots.register({ name: 'shell.overlay', id: 'perse-cua.driving', locale: 'perse-cua' }, View))
      return async () => { closed = true; sequence++; if (retry) clearTimeout(retry); retire(stream); for (const dispose of [stopReset, unregister]) { try { dispose() } catch (error) { errors.push(error) } } listeners.clear(); await Promise.all([...tasks]); if (errors.length) throw new AggregateError(errors, '[perse-cua] cannot fully stop view') }
    })
    yield scope.dispose
  })
  try { await mount.await(); await scope.await() } catch (error) { await owner(); throw error }
}
