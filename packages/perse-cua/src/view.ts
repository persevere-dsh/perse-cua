import type { Context } from '@deepseek-ai/cordis'
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

  constructor(ctx: Context) { super(ctx, 'perseCuaView') }
  setDismissHandler(fn: (id: string) => void): void { this.onDismiss = fn }
  put(item: PreviewWindow): void { if (!this.closed) { this.windows.set(item.id, item); this.emit() } }
  remove(id: string): void { if (this.windows.delete(id)) this.emit() }
  @Remote('dismiss')
  dismiss(id: string): void { this.onDismiss?.(id); this.remove(id) }
  close(): void { this.closed = true; this.windows.clear(); this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
  /** Stream current previews and subsequent changes. */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<PreviewWindow[]> {
    let dirty = true
    let wake: (() => void) | undefined
    const notify = (): void => { dirty = true; wake?.(); wake = undefined }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify)
    try {
      while (!signal.aborted && !this.closed) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve })
        if (signal.aborted || this.closed) break
        dirty = false
        yield [...this.windows.values()]
      }
    } finally { this.listeners.delete(notify); signal.removeEventListener('abort', notify) }
  }
}
