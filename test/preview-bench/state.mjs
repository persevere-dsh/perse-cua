/** A deterministic source of window updates for the isolated preview bench. */
export function createPreviewFixture(makeImage) {
  const sizes = [[420, 280], [280, 420], [640, 180], [160, 160]]
  let items = ['Red', 'Green', 'Blue'].map((title, index) => ({ id: `bench/app/${index + 1}`, title, action: 'getState', frame: 0, size: 0, failed: false }))
  const subscribers = new Set()
  let rejectDismiss = false
  const snapshot = () => items.map(({ frame, size, ...item }) => ({ ...item, image: makeImage(item.title, frame, ...sizes[size]), capturedAt: 1700000000000 + frame * 1000 }))
  const emit = () => { for (const notify of subscribers) notify() }
  return {
    snapshot,
    frame(id) { items = items.map(item => item.id === id ? { ...item, frame: item.frame + 1 } : item); emit() },
    resize(id) { items = items.map(item => item.id === id ? { ...item, size: (item.size + 1) % sizes.length } : item); emit() },
    setFailure(value) { rejectDismiss = value },
    reset() { items = ['Red', 'Green', 'Blue'].map((title, index) => ({ id: `bench/app/${index + 1}`, title, action: 'getState', frame: 0, size: 0, failed: false })); emit() },
    async dismiss(session, id) { if (rejectDismiss) throw new Error('Fixture dismissal failed'); if (session !== 'bench') throw new Error('Unknown fixture session'); items = items.filter(item => item.id !== id); emit() },
    watch(session) {
      if (session !== 'bench') throw new Error('Unknown fixture session')
      let closed = false, dirty = true, wake
      const notify = () => { dirty = true; wake?.(); wake = undefined }
      subscribers.add(notify)
      return {
        async dispose() { closed = true; notify() },
        async *[Symbol.asyncIterator]() {
          try { while (!closed) { if (!dirty) await new Promise(resolve => { wake = resolve }); if (closed) break; dirty = false; yield snapshot() } }
          finally { subscribers.delete(notify) }
        },
      }
    },
  }
}
