/** A deterministic source of window updates for the isolated preview bench. */
export function createPreviewFixture(makeImage) {
  const sizes = [[420, 280], [280, 420], [640, 180], [160, 160]]
  const initial = session => (session === 'bench' ? ['Red', 'Green', 'Blue'] : ['Purple']).map((title, index) => ({ id: `${session}/app/${index + 1}`, title, action: 'getState', frame: 0, size: 0, failed: false }))
  const items = new Map([['bench', initial('bench')], ['other', initial('other')]])
  const subscribers = new Map()
  let rejectDismiss = false
  let delayed
  const snapshot = (session = 'bench') => (items.get(session) ?? []).map(({ frame, size, noImage, ...item }) => ({ ...item, ...(!item.previewUnavailable && !noImage ? { image: makeImage(item.title, frame, ...sizes[size]), capturedAt: 1700000000000 + frame * 1000 } : {}) }))
  const emit = session => { for (const notify of subscribers.get(session) ?? []) notify() }
  const update = (id, fn) => { const session = id.split('/')[0]; items.set(session, (items.get(session) ?? []).map(item => item.id === id ? fn(item) : item)); emit(session) }
  return {
    snapshot,
    frame(id) { update(id, item => ({ ...item, frame: item.frame + 1 })) },
    queueFrame(id) { const item = (items.get(id.split('/')[0]) ?? []).find(row => row.id === id); delayed = item && { id, frame: item.frame + 1 } },
    releaseFrame() { if (delayed) { const { id, frame } = delayed; delayed = undefined; update(id, item => frame > item.frame ? { ...item, frame } : item) } },
    resize(id) { update(id, item => ({ ...item, size: (item.size + 1) % sizes.length })) },
    status(id, status) { update(id, item => ({ ...item, previewUnavailable: status === 'failed', windowUnavailable: status === 'offscreen' || status === 'offscreen-empty', noImage: status === 'offscreen-empty' || status === 'waiting' })) },
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
