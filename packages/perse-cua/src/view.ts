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
  previewUnavailable?: boolean
  /** The target was absent or off-screen in the latest window enumeration. */
  windowUnavailable?: boolean
  /** Action point normalized to the image on this item. */
  point?: { x: number; y: number }
}

/** Streams the plugin's window previews without relying on host events. @typert service perseCuaView */
export class PreviewService extends TypertRemoteService {
  private readonly windows = new Map<string, PreviewWindow>()
  private readonly listeners = new Set<() => void>()
  private closed = false
  private onDismiss?: (id: string) => void
  private onWatch?: (sessionId: string, active: boolean) => void

  constructor(ctx: Context) { super(ctx, 'perseCuaView') }
  setWatchHandler(fn: (sessionId: string, active: boolean) => void): void { this.onWatch = fn }
  setDismissHandler(fn: (id: string) => void): void { this.onDismiss = fn }
  put(item: PreviewWindow): void { if (!this.closed) { this.windows.set(item.id, item); this.emit() } }
  remove(id: string): void { if (this.windows.delete(id)) this.emit() }
  @Remote({ name: 'dismiss', resources: { session: (sessionId: string) => sessionId as SessionId } })
  dismiss(sessionId: string, id: string): void { if (!id.startsWith(`${encodeURIComponent(sessionId)}/`)) return; this.onDismiss?.(id); this.remove(id) }
  close(): void { this.closed = true; this.windows.clear(); this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
  /** Stream current previews and subsequent changes. */
  @Remote({ mode: 'stream', resources: { session: (sessionId: string) => sessionId as SessionId } })
  async *watch(sessionId: string, signal: AbortSignal): AsyncIterable<PreviewWindow[]> {
    let dirty = true
    let wake: (() => void) | undefined
    const notify = (): void => { dirty = true; wake?.(); wake = undefined }
    this.listeners.add(notify)
    this.onWatch?.(sessionId, true)
    signal.addEventListener('abort', notify)
    try {
      while (!signal.aborted && !this.closed) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve })
        if (signal.aborted || this.closed) break
        dirty = false
        yield [...this.windows.values()].filter(item => item.id.startsWith(`${encodeURIComponent(sessionId)}/`))
      }
    } finally { this.onWatch?.(sessionId, false); this.listeners.delete(notify); signal.removeEventListener('abort', notify) }
  }
}
