/** Serializes one native connection and shares turns between foreground and preview work. */
export class NativeRequestArbiter {
  #queues = { input: [], foreground: [], preview: [] }
  #active
  #last = 'preview'
  #closed = false
  #failure

  constructor(failure = (code, message) => Object.assign(new Error(message), { code })) { this.#failure = failure }

  /** Queue one request; the provided signal also cancels it while active. */
  run(kind, signal, dispatch, { preempt = false, waitMs } = {}) {
    if (this.#closed) return Promise.reject(this.#failure('NATIVE_CLOSED', 'Native request queue is closed'))
    if (signal.aborted) return Promise.reject(kind === 'preview' ? this.#failure('NATIVE_CANCELLED', 'Native preview was cancelled') : signal.reason)
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const bucket = preempt && kind === 'foreground' ? 'input' : kind
      const item = { kind, bucket, signal, dispatch, controller, resolve, reject }
      const abort = () => {
        const reason = kind === 'preview' ? this.#failure('NATIVE_CANCELLED', 'Native preview was cancelled') : signal.reason
        controller.abort(reason)
        if (this.#active === item) return
        const queue = this.#queues[bucket], index = queue.indexOf(item)
        if (index >= 0) queue.splice(index, 1)
        clearTimeout(item.timer)
        signal.removeEventListener('abort', abort)
        reject(reason)
      }
      item.abort = abort
      signal.addEventListener('abort', abort, { once: true })
      this.#queues[bucket].push(item)
      if (waitMs !== undefined) item.timer = setTimeout(() => {
        const queue = this.#queues[bucket], index = queue.indexOf(item)
        if (index < 0) return
        queue.splice(index, 1); signal.removeEventListener('abort', abort)
        reject(this.#failure(kind === 'preview' ? 'NATIVE_BUSY' : 'NATIVE_TIMEOUT', 'Native request timed out while waiting for the connection'))
      }, waitMs)
      if (preempt && this.#active?.kind === 'preview') this.#active.controller.abort(this.#failure('NATIVE_CANCELLED', 'Native preview was cancelled'))
      if (signal.aborted) abort(); else this.#drain()
    })
  }

  /** Reject queued work and cancel the active request. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#active?.controller.abort(this.#failure('NATIVE_CLOSED', 'Native request queue is closed'))
    for (const queue of Object.values(this.#queues)) for (const item of queue.splice(0)) {
      clearTimeout(item.timer)
      item.signal.removeEventListener('abort', item.abort)
      item.reject(this.#failure('NATIVE_CLOSED', 'Native request queue is closed'))
    }
  }

  #drain() {
    if (this.#closed || this.#active) return
    const preferred = this.#last === 'foreground' ? 'preview' : 'foreground'
    const other = preferred === 'preview' ? 'foreground' : 'preview'
    const item = this.#queues.input.shift() ?? this.#queues[preferred].shift() ?? this.#queues[other].shift()
    if (!item) return
    clearTimeout(item.timer)
    this.#active = item
    if (item.bucket !== 'input') this.#last = item.kind
    Promise.resolve().then(() => {
      item.controller.signal.throwIfAborted()
      return item.dispatch(item.controller.signal)
    }).then(item.resolve, item.reject).finally(() => {
      item.signal.removeEventListener('abort', item.abort)
      this.#active = undefined
      this.#drain()
    })
  }
}
