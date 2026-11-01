import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** One window observed by this plugin. Images belong to the named window. */
export interface PreviewWindow {
  id: string
  title: string
  action: string
  image?: string
  capturedAt?: number
  failed?: boolean
  working?: boolean
  /** The turn that last used this window has ended. */
  activity?: 'completed' | 'stopped' | 'failed'
  /** Reason a background preview cannot currently update. */
  previewIssue?: 'accessibility' | 'screenRecording' | 'connection' | 'window' | 'busy'
  previewUnavailable?: boolean
  /** Window discovery failed for the application. */
  discoveryUnavailable?: boolean
  /** The target was absent or off-screen in the latest window enumeration. */
  windowUnavailable?: boolean
  /** Action point normalized to the image on this item. */
  point?: { x: number; y: number }
}

/** Streams the plugin's window previews without relying on host events. @typert service perseCuaView */
export class PreviewService extends TypertRemoteService {
  private readonly windows = new Map<string, PreviewWindow>()
  private readonly listeners = new Set<(item?: PreviewWindow, invalidatedId?: string, freshPoint?: boolean) => void>()
  private closed = false
  private onDismiss?: (id: string) => void
  private onWatch?: (sessionId: string, active: boolean) => void

  constructor(ctx: Context) { super(ctx, 'perseCuaView') }
  setWatchHandler(fn: (sessionId: string, active: boolean) => void): void { this.onWatch = fn }
  setDismissHandler(fn: (id: string) => void): void { this.onDismiss = fn }
  put(item: PreviewWindow, freshPoint: boolean = false): void { if (!this.closed) { this.windows.set(item.id, item); this.emit(item, undefined, freshPoint) } }
  remove(id: string): void { if (this.windows.delete(id)) this.emit(undefined, id) }
  /** Discard undelivered click feedback for a window whose geometry or visibility changed. */
  invalidatePoint(id: string): void {
    const item = this.windows.get(id)
    if (item?.point) { const { point: _point, ...rest } = item; this.windows.set(id, rest) }
    this.emit(undefined, id)
  }
  @Remote({ name: 'dismiss', resources: { session: (sessionId: string) => sessionId as SessionId } })
  dismiss(sessionId: string, id: string): void { if (!id.startsWith(`${encodeURIComponent(sessionId)}/`)) return; this.onDismiss?.(id); this.remove(id) }
  close(): void { this.closed = true; for (const id of this.windows.keys()) this.emit(undefined, id); this.windows.clear(); this.emit() }
  private emit(item?: PreviewWindow, invalidatedId?: string, freshPoint = false): void { for (const listener of this.listeners) listener(item, invalidatedId, freshPoint) }
  /** Stream current previews and subsequent changes. */
  @Remote({ mode: 'stream', resources: { session: (sessionId: string) => sessionId as SessionId } })
  async *watch(sessionId: string, signal: AbortSignal): AsyncIterable<PreviewWindow[]> {
    let dirty = true
    let wake: (() => void) | undefined
    const pending = new Map<string, { item: PreviewWindow; expiresAt: number; timer: ReturnType<typeof setTimeout> }>()
    const clearPending = (id: string): void => { const entry = pending.get(id); if (entry) clearTimeout(entry.timer); pending.delete(id) }
    const clearAll = (): void => { for (const id of pending.keys()) clearPending(id) }
    const notify = (item?: PreviewWindow, invalidatedId?: string, freshPoint = false): void => {
      if (invalidatedId) clearPending(invalidatedId)
      if (item && (!item.image || item.windowUnavailable || item.previewUnavailable || item.failed)) clearPending(item.id)
      if (freshPoint && item?.point && item.image && !item.windowUnavailable && !item.previewUnavailable && !item.failed && item.id.startsWith(`${encodeURIComponent(sessionId)}/`)) {
        clearPending(item.id)
        const expiresAt = Date.now() + 900
        const timer = setTimeout(() => clearPending(item.id), 900)
        pending.set(item.id, { item, expiresAt, timer })
      }
      dirty = true; wake?.(); wake = undefined
    }
    this.listeners.add(notify)
    this.onWatch?.(sessionId, true)
    const abort = (): void => { clearAll(); dirty = true; wake?.(); wake = undefined }
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted && !this.closed) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve })
        if (signal.aborted || this.closed) break
        dirty = false
        const items = [...this.windows.values()].filter(item => item.id.startsWith(`${encodeURIComponent(sessionId)}/`))
        for (const [id, entry] of pending) {
          clearPending(id)
          if (Date.now() >= entry.expiresAt) continue
          const index = items.findIndex(item => item.id === id)
          if (index >= 0) { items[index] = entry.item; dirty = true }
        }
        yield items
      }
    } finally { clearAll(); this.onWatch?.(sessionId, false); this.listeners.delete(notify); signal.removeEventListener('abort', abort) }
  }
}
