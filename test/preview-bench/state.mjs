import trajectory from './trajectory.mjs'

/** A deterministic source of window updates for the isolated preview bench. */
export function createPreviewFixture(makeImage) {
  const sizes = [[420, 280], [280, 420], [640, 180], [160, 160]]
  const initial = session => (session === 'bench' ? ['Red', 'Green', 'Blue'] : ['Purple']).map((title, index) => ({ id: `${session}/app/${index + 1}`, title, action: 'getState', frame: 0, size: 0, failed: false }))
  const items = new Map([['bench', initial('bench')], ['other', initial('other')]])
  const subscribers = new Map()
  let rejectDismiss = false
  let delayed, sequence = 0
  const snapshot = (session = 'bench') => (items.get(session) ?? []).map(({ frame, size, noImage, motionAt, clickAt, ...item }) => ({ ...item, ...(item.motion && motionAt !== undefined ? { motion: { ...item.motion, elapsedMs: Math.max(0, performance.now() - motionAt), ...(clickAt === undefined ? {} : { clickElapsedMs: Math.max(0, performance.now() - clickAt) }) } } : {}), ...(!item.previewUnavailable && !noImage ? { image: makeImage(item.title, frame, ...sizes[size]), capturedAt: 1700000000000 + frame * 1000 } : {}) }))
  const emit = session => { for (const notify of subscribers.get(session) ?? []) notify() }
  const update = (id, fn) => { const session = id.split('/')[0]; items.set(session, (items.get(session) ?? []).map(item => item.id === id ? fn(item) : item)); emit(session) }
  return {
    snapshot,
    frame(id) { update(id, item => ({ ...item, frame: item.frame + 1 })) },
    move(id) { const at = performance.now(); update(id, item => ({ ...item, motionAt: at, clickAt: undefined, motion: { sequence: ++sequence, color: '#5EC0E8', trajectory, elapsedMs: 0, phase: 'move' } })) },
    click(id) { const at = performance.now(); update(id, item => ({ ...item, motionAt: item.motionAt ?? at, clickAt: at, motion: { sequence: ++sequence, color: '#5EC0E8', trajectory: item.motion?.trajectory ?? { samples: [trajectory.samples.at(-1)], arrivalT: 0 }, elapsedMs: item.motionAt === undefined ? 0 : at - item.motionAt, clickElapsedMs: 0, phase: 'click' } })) },
    clearMotion(id) { update(id, item => ({ ...item, motion: undefined, motionAt: undefined, clickAt: undefined })) },
    queueFrame(id) { const item = (items.get(id.split('/')[0]) ?? []).find(row => row.id === id); delayed = item && { id, frame: item.frame + 1 } },
    releaseFrame() { if (delayed) { const { id, frame } = delayed; delayed = undefined; update(id, item => frame > item.frame ? { ...item, frame } : item) } },
    resize(id) { update(id, item => ({ ...item, size: (item.size + 1) % sizes.length })) },
    status(id, status) { update(id, item => ({ ...item, previewUnavailable: status === 'failed' || status === 'failed-discovery', windowUnavailable: status === 'offscreen' || status === 'offscreen-empty' || status === 'offscreen-discovery', discoveryUnavailable: status === 'discovery' || status === 'discovery-empty' || status === 'offscreen-discovery' || status === 'failed-discovery', noImage: status === 'offscreen-empty' || status === 'waiting' || status === 'discovery-empty' })) },
    addFourth() { if (!items.get('bench').some(item => item.id === 'bench/app/4')) { items.get('bench').push({ id: 'bench/app/4', title: 'Yellow', action: 'getState', frame: 0, size: 0, failed: false }); emit('bench') } },
    setFailure(value) { rejectDismiss = value },
    reset() { items.set('bench', initial('bench')); items.set('other', initial('other')); delayed = undefined; emit('bench'); emit('other') },
    async dismiss(session, id) { if (rejectDismiss) throw new Error('Fixture dismissal failed'); if (!items.has(session)) throw new Error('Unknown fixture session'); items.set(session, items.get(session).filter(item => item.id !== id)); emit(session) },
    disconnect(session) { for (const notify of [...(subscribers.get(session) ?? [])]) notify(true) },
    watch(session) {
      if (!items.has(session)) throw new Error('Unknown fixture session')
      let closed = false, dirty = true, wake
      const notify = (end = false) => { if (end) closed = true; dirty = true; wake?.(); wake = undefined }
      const active = subscribers.get(session) ?? new Set(); active.add(notify); subscribers.set(session, active)
      return {
        async dispose() { notify(true) },
        async *[Symbol.asyncIterator]() {
          try { while (!closed) { if (!dirty) await new Promise(resolve => { wake = resolve }); if (closed) break; dirty = false; yield snapshot(session) } }
          finally { active.delete(notify); if (!active.size) subscribers.delete(session) }
        },
      }
    },
  }
}
