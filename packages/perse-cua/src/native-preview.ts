import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreviewService, PreviewWindow } from './view.ts'
import type { Capture, Hooks, ListWindows } from 'perse-cua/internal-provider'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined

const connectionFailures = new Set(['PERMISSION_DENIED', 'NATIVE_CLOSED', 'NATIVE_DISPOSED', 'NATIVE_CLEANUP', 'NATIVE_IO', 'NATIVE_EOF', 'NATIVE_EXITED', 'NATIVE_PROTOCOL', 'NATIVE_RESPONSE_LIMIT'])
const failureKind = (code: unknown): 'connection' | 'application' | 'timeout' | 'other' =>
  typeof code === 'string' && connectionFailures.has(code) ? 'connection' : code === 'STALE_APP' ? 'application' : code === 'NATIVE_TIMEOUT' ? 'timeout' : 'other'

/** Project native tool outcomes to per-agent, per-window previews. */
export function observeNative(ctx: Context, view: PreviewService, options: { intervalMs?: number | undefined } = {}): { hooks: Hooks; close: () => void } {
  const clients = new Map<Agent, Capture>()
  const lists = new Map<Agent, ListWindows>()
  const watchers = new Map<string, number>()
  const watcherVersions = new Map<string, object>()
  const dismissed = new Set<string>()
  const automatic = new Set<string>()
  const appearances = new Map<string, number>()
  const missing = new Map<string, number>()
  const unsupported = new Set<string>()
  const discoveryStatus = new Set<string>()
  let background: AbortController | undefined
  let backgroundAgent: Agent | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let captureOrder = 0
  const captured = new Map<string, number>()
  const intervalMs = options.intervalMs ?? 3000
  const captures = new Map<string, AbortController>()
  const pointTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearPoint = (id: string): void => { const timer = pointTimers.get(id); if (timer) clearTimeout(timer); pointTimers.delete(id) }
  let closed = false
  const owners = new Map<Agent, Map<string, { name: string; selected?: number; windows: Map<number, PreviewWindow>; snapshots: Map<string, number>; modelImages: Map<number, { image: string; width: number; height: number }>; observations: Map<number, { width: number; height: number }>; windowSizes: Map<number, { width: number; height: number }>; captures: Map<number, { image: string; width: number; height: number }> }>>()
  const idFor = (agent: Agent, handle: string, id: number): string => `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/${id}`
  const disposed = new WeakSet<Agent>()
  const invalidateFrames = (agent: Agent, handle: string, scope: 'application' | 'connection', reason: 'discoveryUnavailable' | 'previewUnavailable'): void => {
    const apps = owners.get(agent)
    if (!apps) return
    for (const [appHandle, app] of apps) {
      if (scope === 'application' && appHandle !== handle) continue
      app.captures.clear(); app.modelImages.clear()
      for (const [windowId, item] of app.windows) {
        captures.get(item.id)?.abort(); captures.delete(item.id); clearPoint(item.id)
        const { image: _image, capturedAt: _capturedAt, point: _point, ...rest } = item
        if (!item[reason] || item.image || item.capturedAt || item.point) {
          const failed = { ...rest, [reason]: true }; app.windows.set(windowId, failed); view.put(failed)
        }
      }
    }
  }
  view.setDismissHandler(id => { captured.delete(id); dismissed.add(id); discoveryStatus.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id); captures.get(id)?.abort(); captures.delete(id); clearPoint(id); for (const apps of owners.values()) for (const app of apps.values()) for (const [window, item] of app.windows) if (item.id === id) app.windows.delete(window) })
  const schedule = (abort = false, sessionId?: string): void => {
    if (abort && (sessionId === undefined || backgroundAgent?.id === sessionId)) background?.abort()
    if (closed || !watchers.size) {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = undefined
      return
    }
    if (!background && !refreshTimer) refreshTimer = setTimeout(refresh, intervalMs)
  }
  const refresh = async (): Promise<void> => {
    refreshTimer = undefined
    if (closed || background || !watchers.size) return
    const controller = new AbortController(); background = controller
    let current: { agent: Agent; handle: string; window: number; valid: () => boolean } | undefined
    try {
      const candidates: Array<{ agent: Agent; handle: string; window: number; id: string; valid: () => boolean }> = []
      for (const [agent, apps] of owners) {
        if (!watchers.has(agent.id)) continue
        const list = lists.get(agent)
        if (!list) continue
        for (const [handle, app] of apps) {
          const statusId = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/status`
          if (unsupported.has(statusId)) continue
          const version = watcherVersions.get(agent.id), client = clients.get(agent)
          const listValid = (): boolean => watchers.has(agent.id) && watcherVersions.get(agent.id) === version && owners.get(agent)?.get(handle) === app && lists.get(agent) === list && client !== undefined && clients.get(agent) === client
          if (!listValid()) continue
          let rows: Awaited<ReturnType<ListWindows>>
          backgroundAgent = agent
          try { rows = await list(handle, controller.signal) } catch (error) {
            controller.signal.throwIfAborted()
            if (!listValid()) continue
            const code = record(error)?.code
            if (code === 'NATIVE_BUSY' || code === 'NATIVE_CANCELLED') continue
            if (code === 'INVALID_ARGUMENT') {
              unsupported.add(statusId)
              console.warn('[perse-cua] Native helper does not support display-only window discovery; use the helper bundled with this plugin.')
            } else {
              console.warn('[perse-cua] Native preview discovery failed:', typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN')
            }
            const kind = failureKind(code)
            if (kind === 'connection' || kind === 'application') invalidateFrames(agent, handle, kind, 'discoveryUnavailable')
            if (app.windows.size) {
              view.remove(statusId); discoveryStatus.delete(statusId)
              if (kind !== 'connection' && kind !== 'application') for (const [windowId, item] of app.windows) if (!item.discoveryUnavailable) {
                const failed = { ...item, discoveryUnavailable: true }; app.windows.set(windowId, failed); view.put(failed)
              }
            } else if (!dismissed.has(statusId) && !discoveryStatus.has(statusId)) {
              discoveryStatus.add(statusId)
              view.put({ id: statusId, title: app.name, action: 'getApp', discoveryUnavailable: true })
            }
            continue
          }
          controller.signal.throwIfAborted()
          if (!listValid()) continue
          view.remove(statusId); discoveryStatus.delete(statusId)
          dismissed.delete(statusId)
          for (const [windowId, item] of app.windows) if (item.discoveryUnavailable) {
            const { discoveryUnavailable: _discoveryUnavailable, ...recovered } = item
            app.windows.set(windowId, recovered); view.put(recovered)
          }
          const visible = rows.filter(row => row.isOnScreen && row.onCurrentSpace !== false && row.bounds.width > 0 && row.bounds.height > 0)
          const seen = new Set(visible.map(row => row.windowId))
          for (const row of visible) {
            const id = idFor(agent, handle, row.windowId)
            if (dismissed.has(id)) continue
            let old = app.windows.get(row.windowId)
            const size = app.windowSizes.get(row.windowId)
            app.windowSizes.set(row.windowId, { width: row.bounds.width, height: row.bounds.height })
            if (old && size && (size.width !== row.bounds.width || size.height !== row.bounds.height)) {
              captures.get(id)?.abort(); captures.delete(id); clearPoint(id); app.captures.delete(row.windowId); app.modelImages.delete(row.windowId); app.observations.delete(row.windowId)
              const { point: _point, ...rest } = old
              old = { ...rest, previewUnavailable: true }; app.windows.set(row.windowId, old); view.put(old)
            }
            missing.delete(id)
            if (!old) {
              const count = (appearances.get(id) ?? 0) + 1
              appearances.set(id, count)
              if (count < 2) continue
              automatic.add(id)
            }
            const title = [app.name, row.title || 'Window'].filter(Boolean).join(' · ')
            if (!old || old.title !== title || old.windowUnavailable) {
              const { windowUnavailable: _unavailable, ...rest } = old ?? { id, action: 'getState' }
              const item = { ...rest, title }
              app.windows.set(row.windowId, item); view.put(item)
            }
            const item = app.windows.get(row.windowId)
            if (item) candidates.push({ agent, handle, window: row.windowId, id, valid: () =>
              listValid() && app.windows.get(row.windowId) === item && !dismissed.has(id) })
          }
          const prefix = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/`
          for (const id of appearances.keys()) if (id.startsWith(prefix) && !visible.some(row => idFor(agent, handle, row.windowId) === id)) appearances.delete(id)
          for (const [windowId, old] of app.windows) if (!seen.has(windowId)) {
            captures.get(old.id)?.abort(); captures.delete(old.id)
            if (automatic.has(old.id)) {
              const count = (missing.get(old.id) ?? 0) + 1
              missing.set(old.id, count)
              if (count >= 3) { captured.delete(old.id); automatic.delete(old.id); missing.delete(old.id); app.windows.delete(windowId); app.captures.delete(windowId); view.remove(old.id) }
            } else if (!old.windowUnavailable) {
              const item = { ...old, windowUnavailable: true }; app.windows.set(windowId, item); view.put(item)
            }
          }
        }
      }
      const eligible = candidates.filter(candidate => candidate.valid())
      if (!eligible.length) return
      const target = eligible.reduce((oldest, candidate) => (captured.get(candidate.id) ?? 0) < (captured.get(oldest.id) ?? 0) ? candidate : oldest)
      captured.set(target.id, ++captureOrder)
      current = target
      const capture = clients.get(target.agent), app = owners.get(target.agent)?.get(target.handle)
      if (!capture || !app) return
      backgroundAgent = target.agent
      const shot = await capture(target.handle, target.window, controller.signal)
      controller.signal.throwIfAborted()
      const old = app.windows.get(target.window)
      if (!old || !target.valid() || shot.windowId !== target.window) return
      clearPoint(old.id)
      const { point: _point, ...rest } = old
      const image = `data:${shot.mimeType};base64,${shot.data}`
      const item = { ...rest, image, capturedAt: Date.now(), previewUnavailable: false, windowUnavailable: false }
      if (shot.bounds) {
        app.captures.set(target.window, { image, width: shot.bounds.width, height: shot.bounds.height })
        app.windowSizes.set(target.window, { width: shot.bounds.width, height: shot.bounds.height })
      }
      app.windows.set(target.window, item); view.put(item)
    } catch (error) {
      if (!controller.signal.aborted && !closed) {
        const code = record(error)?.code
        if (code !== 'NATIVE_BUSY' && code !== 'NATIVE_CANCELLED') {
          console.warn('[perse-cua] Background preview failed:', typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN')
          const app = current && owners.get(current.agent)?.get(current.handle)
          const old = current && app?.windows.get(current.window)
          if (old && app && current?.valid()) {
            const kind = failureKind(code)
            if (kind === 'connection' || kind === 'application') invalidateFrames(current.agent, current.handle, kind, 'previewUnavailable')
            else {
              const { point: _point, ...withoutPoint } = old
              const { image: _image, capturedAt: _capturedAt, ...withoutImage } = withoutPoint
              clearPoint(old.id); app.captures.delete(current.window)
              const item = { ...(kind === 'timeout' ? withoutPoint : withoutImage), previewUnavailable: true }; app.windows.set(current.window, item); view.put(item)
            }
          }
        }
      }
    } finally { if (background === controller) { background = undefined; backgroundAgent = undefined }; schedule() }
  }
  view.setWatchHandler?.((sessionId, active) => {
    const previous = watchers.get(sessionId) ?? 0
    const count = previous + (active ? 1 : -1)
    if (previous === 0 && count > 0) watcherVersions.set(sessionId, {})
    if (previous > 0 && count <= 0) watcherVersions.delete(sessionId)
    if (count > 0) watchers.set(sessionId, count); else watchers.delete(sessionId)
    schedule(!active && count <= 0, sessionId)
  })
  const stop = ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'cua' || !exec.agent || disposed.has(exec.agent)) return
    const request = record(exec.arguments)
    let rawParams = request?.params
    if (typeof rawParams === 'string') { try { rawParams = JSON.parse(rawParams) } catch { return } }
    const params = record(rawParams)
    const method = request?.method
    if (typeof method !== 'string' || !params) return
    const agent = exec.agent
    let apps = owners.get(agent)
    if (!apps) { apps = new Map(); owners.set(agent, apps) }
    const value = result.isError ? undefined : record(result.value)
    if (method === 'getApp' && typeof value?.appHandle === 'string') {
      const previous = apps.get(value.appHandle)
      if (previous) {
        if (typeof value.name === 'string') previous.name = value.name
      } else apps.set(value.appHandle, { name: typeof value.name === 'string' ? value.name : 'Application', windows: new Map(), snapshots: new Map(), modelImages: new Map(), observations: new Map(), windowSizes: new Map(), captures: new Map() })
      schedule()
      return
    }
    if (typeof params.appHandle !== 'string') return
    const handle = params.appHandle, app = apps.get(handle)
    if (!app) return
    if (method !== 'listWindows' || result.isError) schedule(true, agent.id)
    if (method === 'listWindows' && result.isError) {
      const message = record(result.error)?.message
      const code = typeof message === 'string' ? /^([A-Z][A-Z0-9_]*):/.exec(message)?.[1] : undefined
      const kind = failureKind(code)
      if (kind === 'connection' || kind === 'application') invalidateFrames(agent, handle, kind, 'discoveryUnavailable')
    }
    const rows = method === 'listWindows' && !result.isError && Array.isArray(result.value) ? result.value : method === 'getState' && Array.isArray(value?.windows) ? value.windows : undefined
    if (rows) {
      const seen = new Set<number>()
      for (const row of rows) {
        const window = record(row)
        if (typeof window?.windowId !== 'number') continue
        const windowId = window.windowId; seen.add(windowId)
        const bounds = record(window.bounds)
        const size = app.windowSizes.get(windowId)
        const nextSize = typeof bounds?.width === 'number' && typeof bounds.height === 'number' ? { width: bounds.width, height: bounds.height } : undefined
        const resized = nextSize !== undefined && size !== undefined && (size.width !== nextSize.width || size.height !== nextSize.height)
        if (nextSize) app.windowSizes.set(windowId, nextSize)
        if (method === 'getState' && nextSize) app.observations.set(windowId, nextSize)
        const old = app.windows.get(windowId)
        if (!old) continue
        const title = [app.name, typeof window.title === 'string' ? window.title : ''].filter(Boolean).join(' · ')
        const unavailable = window.isOnScreen === false || window.onCurrentSpace === false
        if (resized || unavailable) { captures.get(old.id)?.abort(); captures.delete(old.id) }
        if (resized) { clearPoint(old.id); app.captures.delete(windowId); app.modelImages.delete(windowId); if (method !== 'getState') app.observations.delete(windowId) }
        if (old.title !== title || !!old.windowUnavailable !== unavailable || resized) {
          const { windowUnavailable: _unavailable, point, ...rest } = old
          const item = { ...rest, title, ...(!resized && point ? { point } : {}), ...(unavailable ? { windowUnavailable: true } : {}), ...(resized ? { previewUnavailable: true } : {}) }
          app.windows.set(windowId, item); view.put(item)
        }
      }
      for (const [windowId, old] of app.windows) if (!seen.has(windowId) && !old.windowUnavailable) { captures.get(old.id)?.abort(); captures.delete(old.id); const item = { ...old, windowUnavailable: true }; app.windows.set(windowId, item); view.put(item) }
    }
    if (method === 'listWindows') return
    const selected = typeof value?.windowId === 'number' ? value.windowId : typeof params.windowId === 'number' ? params.windowId : typeof params.snapshotId === 'string' && app.snapshots.has(params.snapshotId) ? app.snapshots.get(params.snapshotId) : typeof value?.focusedWindowId === 'number' ? value.focusedWindowId : app.selected
    if (selected === undefined) return
    if (method === 'getState' && !result.isError) {
      app.selected = selected
      if (typeof value?.snapshotId === 'string') {
        app.snapshots.set(value.snapshotId, selected)
        while (app.snapshots.size > 128) { const first = app.snapshots.keys().next().value; if (first === undefined) break; app.snapshots.delete(first) }
      }
    }
    const id = idFor(agent, handle, selected)
    dismissed.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id)
    const old = app.windows.get(selected)
    const row = rows?.map(record).find(window => window?.windowId === selected)
    const title = [app.name, typeof row?.title === 'string' ? row.title : ''].filter(Boolean).join(' · ')
    const item: PreviewWindow = { ...old, id, title: row ? title : old?.title ?? title, action: method, ...(result.isError ? { failed: true } : { failed: false }) }
    clearPoint(id)
    delete item.point
    if (result.isError) { delete item.image; delete item.capturedAt }
    if (method === 'screenshot' && typeof value?.data === 'string' && typeof value.mimeType === 'string') {
      item.image = `data:${value.mimeType};base64,${value.data}`; item.capturedAt = Date.now(); item.previewUnavailable = false; item.windowUnavailable = false
      const bounds = record(value.bounds)
      if (typeof bounds?.width === 'number' && bounds.width > 0 && typeof bounds.height === 'number' && bounds.height > 0) app.windowSizes.set(selected, { width: bounds.width, height: bounds.height })
      if (typeof value.pixelWidth === 'number' && typeof value.pixelHeight === 'number' && value.pixelWidth > 0 && value.pixelHeight > 0) app.modelImages.set(selected, { image: item.image, width: value.pixelWidth, height: value.pixelHeight })
    }
    const model = app.modelImages.get(selected)
    const frame = app.captures.get(selected), observed = app.observations.get(selected)
    const relative = params.relative === true && frame && observed && old?.image === frame.image && frame.width === observed.width && frame.height === observed.height
    const pixel = params.relative !== true && model && old?.image === model.image
    if (method === 'click' && !result.isError && value?.dispatched === true && typeof params.windowId === 'number' && typeof params.x === 'number' && typeof params.y === 'number' && params.x >= 0 && params.y >= 0 && ((relative && params.x <= 1000 && params.y <= 1000) || (pixel && params.x < model.width && params.y < model.height))) {
      item.point = relative ? { x: params.x / 1000, y: params.y / 1000 } : { x: params.x / model!.width, y: params.y / model!.height }
      pointTimers.set(id, setTimeout(() => { pointTimers.delete(id); const current = app.windows.get(selected); if (!current) return; const { point: _point, ...rest } = current; app.windows.set(selected, rest); view.put(rest) }, 900))
    }
    app.windows.set(selected, item); view.put(item)
    const previous = captures.get(id)
    previous?.abort()
    captures.delete(id)
    const capture = clients.get(agent)
    if ((method === 'screenshot' && !result.isError) || !capture || item.windowUnavailable) return
    const controller = new AbortController()
    captures.set(id, controller)
    const captureWhenIdle = async (): Promise<Awaited<ReturnType<Capture>>> => {
      let retries = 0
      while (true) {
        try { return await capture(handle, selected, controller.signal) } catch (error) {
          const code = record(error)?.code
          if (controller.signal.aborted || (code !== 'NATIVE_CANCELLED' && code !== 'NATIVE_BUSY') || ++retries >= 150) throw error
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 200)
            function done(): void { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
            controller.signal.addEventListener('abort', done, { once: true })
            if (controller.signal.aborted) done()
          })
          controller.signal.throwIfAborted()
        }
      }
    }
    void captureWhenIdle().then(shot => {
      if (closed || controller.signal.aborted || captures.get(id) !== controller || disposed.has(agent) || shot.windowId !== selected) return
      const latest = app.windows.get(selected)
      if (!latest) return
      clearPoint(id)
      const { point: _point, ...rest } = latest
      const next = { ...rest, image: `data:${shot.mimeType};base64,${shot.data}`, capturedAt: Date.now(), previewUnavailable: false, windowUnavailable: false }
      if (shot.bounds) {
        app.captures.set(selected, { image: next.image, width: shot.bounds.width, height: shot.bounds.height })
        app.windowSizes.set(selected, { width: shot.bounds.width, height: shot.bounds.height })
      }
      app.windows.set(selected, next); view.put(next)
    }).catch(error => {
      if (closed || controller.signal.aborted || captures.get(id) !== controller || disposed.has(agent)) return
      const latest = app.windows.get(selected)
      if (!latest) return
      const code = record(error)?.code
      console.warn('[perse-cua] Native preview capture failed:', typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN')
      const kind = failureKind(code)
      if (kind === 'connection' || kind === 'application') invalidateFrames(agent, handle, kind, 'previewUnavailable')
      else {
        clearPoint(id); app.captures.delete(selected)
        const { point: _point, ...withoutPoint } = latest
        const { image: _image, capturedAt: _capturedAt, ...withoutImage } = withoutPoint
        const next = { ...(kind === 'timeout' ? withoutPoint : withoutImage), previewUnavailable: true }
        app.windows.set(selected, next); view.put(next)
      }
    }).finally(() => { if (captures.get(id) === controller) captures.delete(id) })
  })
  const stopAgent = ctx.on('agent/disposed', ({ agent }) => {
    disposed.add(agent)
    for (const id of captured.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) captured.delete(id)
    clients.delete(agent); lists.delete(agent); for (const id of dismissed) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { dismissed.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id) }; for (const id of automatic) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { automatic.delete(id); missing.delete(id) }; for (const id of appearances.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) appearances.delete(id); schedule(true, agent.id)
    for (const [id, controller] of captures) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { controller.abort(); captures.delete(id) }
    for (const id of pointTimers.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) clearPoint(id)
    const apps = owners.get(agent)
    if (apps) for (const [handle, app] of apps) { const statusId = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/status`; unsupported.delete(statusId); discoveryStatus.delete(statusId); view.remove(statusId); for (const item of app.windows.values()) view.remove(item.id) }
    owners.delete(agent)
  })
  return {
    hooks: {
      onClient: (agent, capture, list) => { if (!closed && !disposed.has(agent)) { clients.set(agent, capture); if (list) lists.set(agent, list) } },
      onRevoke: (agent) => {
        const apps = owners.get(agent)
        if (!apps) return
        for (const [handle, app] of apps) { const statusId = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/status`; unsupported.delete(statusId); discoveryStatus.delete(statusId); view.remove(statusId); for (const item of app.windows.values()) {
          captures.get(item.id)?.abort(); captures.delete(item.id); clearPoint(item.id); view.remove(item.id)
        } }
        owners.delete(agent)
        for (const id of captured.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) captured.delete(id)
        clients.delete(agent); lists.delete(agent); for (const id of dismissed) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { dismissed.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id) }; for (const id of automatic) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { automatic.delete(id); missing.delete(id) }; for (const id of appearances.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) appearances.delete(id); schedule(true, agent.id)
      },
    },
    close: () => { closed = true; if (refreshTimer) clearTimeout(refreshTimer); background?.abort(); watchers.clear(); watcherVersions.clear(); captured.clear(); lists.clear(); dismissed.clear(); automatic.clear(); appearances.clear(); missing.clear(); unsupported.clear(); discoveryStatus.clear(); stop(); stopAgent(); for (const controller of captures.values()) controller.abort(); captures.clear(); for (const id of pointTimers.keys()) clearPoint(id); clients.clear(); owners.clear() },
  }
}
