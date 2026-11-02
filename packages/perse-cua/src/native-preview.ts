import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreviewService, PreviewWindow } from './view.ts'
import type { Capture, Hooks, ListWindows, VisualEvent } from 'perse-cua/internal-provider'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined

type Geometry = { x: number; y: number; width: number; height: number }
const geometry = (value: unknown): Geometry | undefined => {
  const box = record(value)
  return box && typeof box.x === 'number' && Number.isFinite(box.x) && typeof box.y === 'number' && Number.isFinite(box.y) && typeof box.width === 'number' && Number.isFinite(box.width) && box.width > 0 && typeof box.height === 'number' && Number.isFinite(box.height) && box.height > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined
}
const sameGeometry = (a: Geometry | undefined, b: Geometry): boolean => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const connectionFailures = new Set(['PERMISSION_DENIED', 'NATIVE_CLOSED', 'NATIVE_DISPOSED', 'NATIVE_CLEANUP', 'NATIVE_IO', 'NATIVE_EOF', 'NATIVE_EXITED', 'NATIVE_PROTOCOL', 'NATIVE_RESPONSE_LIMIT'])
const transportFailures = new Set(['NATIVE_START_FAILED', 'NATIVE_CLOSED', 'NATIVE_DISPOSED', 'NATIVE_CLEANUP', 'NATIVE_IO', 'NATIVE_EOF', 'NATIVE_EXITED', 'NATIVE_PROTOCOL', 'NATIVE_RESPONSE_LIMIT'])
const failureKind = (code: unknown): 'connection' | 'application' | 'timeout' | 'other' =>
  typeof code === 'string' && connectionFailures.has(code) ? 'connection' : code === 'STALE_APP' ? 'application' : code === 'NATIVE_TIMEOUT' ? 'timeout' : 'other'

/** Project native tool outcomes to per-agent, per-window previews. */
export function observeNative(ctx: Context, view: PreviewService, options: { intervalMs?: number | undefined } = {}): { hooks: Hooks; close: () => void } {
  const getService = typeof ctx.get === 'function' ? ctx.get.bind(ctx) as (name: string) => unknown : undefined
  const health = getService?.('profileToolAdmission') as {
    reportHealth?: (name: string, scope: object, status: { state: 'ready' | 'unavailable'; reason?: string }) => void
    health?: (name: string, scope: object) => { state: 'unknown' | 'ready' | 'unavailable'; reason?: string }
  } | undefined
  const clients = new Map<Agent, Capture>()
  const visualSequences = new Map<Agent, number>()
  const visualStarts = new Map<string, { requestId: string; identity: string; geometry: Geometry; sequence: number; elapsedMs: number; at: number }>()
  const processes = new Map<Agent, Map<string, string>>()
  const lists = new Map<Agent, ListWindows>()
  const watchers = new Map<string, number>()
  const watcherVersions = new Map<string, object>()
  const paused = new Map<string, NonNullable<PreviewWindow['activity']>>()
  const pendingTurns = new Set<string>()
  const activeTurns = new Set<string>()
  const permissionBlocked = new Set<string>()
  const toolSignals = new Map<object, { id: string; signal: AbortSignal; stop: () => void; settled: boolean }>()
  const turnVersions = new Map<string, object>()
  const executionVersions = new WeakMap<object, object>()
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
  let refreshDelay = intervalMs
  const captures = new Map<string, AbortController>()
  const clearMotionTimer = (id: string): void => { visualStarts.delete(id) }
  const pointTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearPoint = (id: string): void => { const timer = pointTimers.get(id); if (timer) clearTimeout(timer); pointTimers.delete(id) }
  let closed = false
  const owners = new Map<Agent, Map<string, { name: string; selected?: number; windows: Map<number, PreviewWindow>; snapshots: Map<string, number>; modelImages: Map<number, { image: string; width: number; height: number }>; observations: Map<number, { width: number; height: number }>; windowSizes: Map<number, { width: number; height: number }>; captures: Map<number, { image: string; width: number; height: number }>; windowBounds: Map<number, Geometry>; frameBounds: Map<number, Geometry> }>>()
  const idFor = (agent: Agent, handle: string, id: number): string => `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/${id}`
  const disposed = new WeakSet<Agent>()
  const recordConnectionFailure = (agent: Agent, code: string): void => {
    if (closed || disposed.has(agent) || !transportFailures.has(code)) return
    clearPendingSession(agent.id)
    for (const app of owners.get(agent)?.values() ?? []) { app.frameBounds.clear(); for (const [windowId, item] of app.windows) if (item.motion) { clearMotionTimer(item.id); const { motion: _motion, ...rest } = item; app.windows.set(windowId, rest); view.put(rest) } }
    health?.reportHealth?.('cua', agent, { state: 'unavailable', reason: code })
    const status = health?.health?.('cua', agent) ?? { state: 'unavailable', reason: code }
    if (status.state === 'unavailable') view.put({ id: `${encodeURIComponent(agent.id)}/native-status`, title: 'CUA', action: 'getState', failed: true, previewUnavailable: true, previewIssue: 'connection' })
  }
  const recordConnectionReady = (agent: Agent): void => {
    if (closed || disposed.has(agent)) return
    health?.reportHealth?.('cua', agent, { state: 'ready' })
    view.remove(`${encodeURIComponent(agent.id)}/native-status`)
  }
  const invalidateFrames = (agent: Agent, handle: string, scope: 'application' | 'connection', reason: 'discoveryUnavailable' | 'previewUnavailable', issue?: PreviewWindow['previewIssue']): void => {
    const apps = owners.get(agent)
    if (!apps) return
    for (const [appHandle, app] of apps) {
      if (scope === 'application' && appHandle !== handle) continue
      app.captures.clear(); app.modelImages.clear(); app.frameBounds.clear()
      for (const [windowId, item] of app.windows) {
        captures.get(item.id)?.abort(); captures.delete(item.id); clearPoint(item.id)
        clearMotionTimer(item.id)
        const { image: _image, capturedAt: _capturedAt, point: _point, motion: _motion, ...rest } = item
        if (!item[reason] || item.image || item.capturedAt || item.point || (issue !== undefined && item.previewIssue !== issue)) {
          const failed = { ...rest, [reason]: true, ...(issue ? { previewIssue: issue } : {}) }; app.windows.set(windowId, failed); view.put(failed)
        }
      }
    }
  }
  view.setDismissHandler(id => { captured.delete(id); dismissed.add(id); discoveryStatus.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id); captures.get(id)?.abort(); captures.delete(id); clearPoint(id); clearMotionTimer(id); clearPendingVisual(id); for (const apps of owners.values()) for (const app of apps.values()) for (const [window, item] of app.windows) if (item.id === id) { app.windows.delete(window); app.windowSizes.delete(window); app.windowBounds.delete(window); app.frameBounds.delete(window) } })
  const pendingVisuals = new Map<string, { agent: Agent; events: Array<{ event: VisualEvent; at: number }> }>()
  const clearPendingVisual = (id: string): void => { pendingVisuals.delete(id) }
  const clearPendingSession = (id: string): void => { for (const key of pendingVisuals.keys()) if (key.startsWith(`${encodeURIComponent(id)}/`)) clearPendingVisual(key) }
  const publishVisual = (agent: Agent, event: VisualEvent): boolean => {
    const app = owners.get(agent)?.get(event.appHandle), item = app?.windows.get(event.windowId)
    if (event.phase === 'clear') return false
    if (!app || !item || !sameGeometry(app.windowBounds.get(event.windowId), event.geometry) || !sameGeometry(app.frameBounds.get(event.windowId), event.geometry) || !item.image || item.windowUnavailable || item.previewUnavailable) return false
        const prior = visualStarts.get(item.id)
        clearMotionTimer(item.id)
        const { point: _point, ...rest } = item
        const continuing = event.phase === 'click' && item.motion?.phase === 'move' && prior?.requestId === event.requestId && prior.sequence === item.motion.sequence
        const elapsedMs = continuing ? prior.elapsedMs + Math.max(0, performance.now() - prior.at) : event.elapsedMs
        const motion = { sequence: event.sequence, color: event.color, trajectory: continuing ? item.motion!.trajectory : event.trajectory, elapsedMs, ...(event.phase === 'click' ? { clickElapsedMs: event.elapsedMs } : {}), phase: event.phase }
        visualStarts.set(item.id, { requestId: event.requestId, identity: `${event.process.pid}/${event.process.startedSeconds}/${event.process.startedMicroseconds}`, geometry: event.geometry, sequence: event.sequence, elapsedMs, at: performance.now() })
        const next = { ...rest, motion }; app.windows.set(event.windowId, next); view.put(next)
    return true
  }
  const applyPendingVisual = (agent: Agent, handle: string, windowId: number): void => {
    const id = idFor(agent, handle, windowId), pending = pendingVisuals.get(id)
    if (!pending || pending.agent !== agent) return
    const app = owners.get(agent)?.get(handle), bounds = app?.windowBounds.get(windowId)
    if (bounds && pending.events.some(({ event }) => !sameGeometry(bounds, event.geometry))) { clearPendingVisual(id); return }
    const now = performance.now()
    const events = pending.events.map(({ event, at }) => ({ ...event, elapsedMs: event.elapsedMs + Math.max(0, now - at) }))
    if (events.every(event => publishVisual(agent, event))) clearPendingVisual(id)
  }
  const onVisual = (agent: Agent, event: VisualEvent): void => {
    if (closed || disposed.has(agent) || paused.has(agent.id) || event.sequence <= (visualSequences.get(agent) ?? -1)) return
    visualSequences.set(agent, event.sequence)
    const app = owners.get(agent)?.get(event.appHandle)
    if (!app) return
    const identity = `${event.process.pid}/${event.process.startedSeconds}/${event.process.startedMicroseconds}`
    let identities = processes.get(agent); if (!identities) { identities = new Map(); processes.set(agent, identities) }
    const id = idFor(agent, event.appHandle, event.windowId), item = app.windows.get(event.windowId)
    if (event.phase === 'clear') {
      const matches = (other: VisualEvent): boolean => other.requestId === event.requestId && sameGeometry(other.geometry, event.geometry) && other.process.pid === event.process.pid && other.process.startedSeconds === event.process.startedSeconds && other.process.startedMicroseconds === event.process.startedMicroseconds
      if (pendingVisuals.get(id)?.events.some(({ event: previous }) => matches(previous))) clearPendingVisual(id)
      const previous = visualStarts.get(id)
      if (item?.motion && previous?.requestId === event.requestId && previous.identity === identity && sameGeometry(previous.geometry, event.geometry)) { clearMotionTimer(id); const { motion: _motion, ...rest } = item; app.windows.set(event.windowId, rest); view.put(rest) }
      return
    }
    if ((identities.has(event.appHandle) && identities.get(event.appHandle) !== identity) || dismissed.has(id)) {
      clearPendingVisual(id); if (item?.motion) { clearMotionTimer(id); const { motion: _motion, ...rest } = item; app.windows.set(event.windowId, rest); view.put(rest) }; return
    }
    identities.set(event.appHandle, identity)
    for (const [otherId, pending] of pendingVisuals) if (pending.agent === agent && otherId !== id) clearPendingVisual(otherId)
    for (const otherApp of owners.get(agent)?.values() ?? []) for (const [windowId, other] of otherApp.windows) if (other.id !== id && other.motion) {
      clearMotionTimer(other.id); const { motion: _motion, ...rest } = other; otherApp.windows.set(windowId, rest); view.put(rest)
    }
    const bounds = app.windowBounds.get(event.windowId)
    if (bounds && !sameGeometry(bounds, event.geometry)) {
      clearPendingVisual(id); if (item?.motion) { clearMotionTimer(id); const { motion: _motion, ...rest } = item; app.windows.set(event.windowId, rest); view.put(rest) }; return
    }
    if (publishVisual(agent, event)) { clearPendingVisual(id); return }
    if (item?.motion) { clearMotionTimer(id); const { motion: _motion, ...rest } = item; app.windows.set(event.windowId, rest); view.put(rest) }
    const prior = pendingVisuals.get(id), now = performance.now()
    const previous = event.phase === 'click' && prior?.agent === agent ? prior.events.find(entry => entry.event.phase === 'move' && entry.event.requestId === event.requestId) : undefined
    clearPendingVisual(id)
    pendingVisuals.set(id, { agent, events: [...(previous ? [previous] : []), { event, at: now }] })
    while (pendingVisuals.size > 128) { const oldest = pendingVisuals.keys().next().value; if (oldest === undefined) break; clearPendingVisual(oldest) }
  }
  const clearRequestVisual = (agent: Agent, requestId: string): void => {
    for (const [id, pending] of pendingVisuals) if (pending.agent === agent && pending.events.some(({ event }) => event.requestId === requestId)) clearPendingVisual(id)
    for (const app of owners.get(agent)?.values() ?? []) for (const [windowId, item] of app.windows) {
      if (visualStarts.get(item.id)?.requestId !== requestId) continue
      clearMotionTimer(item.id); const { motion: _motion, ...rest } = item; app.windows.set(windowId, rest); view.put(rest)
    }
  }
  const schedule = (abort = false, sessionId?: string): void => {
    if (abort && (sessionId === undefined || backgroundAgent?.id === sessionId)) background?.abort()
    if (closed || !watchers.size || [...watchers.keys()].every(id => paused.has(id) || permissionBlocked.has(id))) {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = undefined
      return
    }
    if (!background && !refreshTimer) refreshTimer = setTimeout(refresh, refreshDelay)
  }
  const refresh = async (): Promise<void> => {
    refreshTimer = undefined
    if (closed || background || !watchers.size) return
    const controller = new AbortController(); background = controller
    let current: { agent: Agent; handle: string; window: number; valid: () => boolean } | undefined
    try {
      const candidates: Array<{ agent: Agent; handle: string; window: number; id: string; valid: () => boolean }> = []
      for (const [agent, apps] of owners) {
        if (!watchers.has(agent.id) || paused.has(agent.id) || permissionBlocked.has(agent.id)) continue
        const list = lists.get(agent)
        if (!list) continue
        for (const [handle, app] of apps) {
          const statusId = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/status`
          if (unsupported.has(statusId)) continue
          const version = watcherVersions.get(agent.id), client = clients.get(agent)
          const listValid = (): boolean => watchers.has(agent.id) && !paused.has(agent.id) && !permissionBlocked.has(agent.id) && watcherVersions.get(agent.id) === version && owners.get(agent)?.get(handle) === app && lists.get(agent) === list && client !== undefined && clients.get(agent) === client
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
            const issue: PreviewWindow['previewIssue'] = code === 'PERMISSION_DENIED' ? 'accessibility' : kind === 'connection' ? 'connection' : undefined
            if (code === 'PERMISSION_DENIED') permissionBlocked.add(agent.id)
            if (kind === 'connection' || kind === 'application') invalidateFrames(agent, handle, kind, 'discoveryUnavailable', issue)
            if (app.windows.size) {
              view.remove(statusId); discoveryStatus.delete(statusId)
              if (kind !== 'connection' && kind !== 'application') for (const [windowId, item] of app.windows) if (!item.discoveryUnavailable) {
                const failed = { ...item, discoveryUnavailable: true }; app.windows.set(windowId, failed); view.put(failed)
              }
            } else if (!dismissed.has(statusId) && !discoveryStatus.has(statusId)) {
              discoveryStatus.add(statusId)
              view.put({ id: statusId, title: app.name, action: 'getApp', discoveryUnavailable: true, ...(issue ? { previewIssue: issue } : {}) })
            }
            continue
          }
          controller.signal.throwIfAborted()
          if (!listValid()) continue
          view.remove(statusId); discoveryStatus.delete(statusId)
          dismissed.delete(statusId)
          for (const [windowId, item] of app.windows) if (item.discoveryUnavailable) {
            const { discoveryUnavailable: _discoveryUnavailable, previewIssue: _previewIssue, ...recovered } = item
            app.windows.set(windowId, recovered); view.put(recovered)
          }
          const visible = rows.filter(row => row.isOnScreen && row.onCurrentSpace !== false && row.bounds.width > 0 && row.bounds.height > 0)
          const seen = new Set(visible.map(row => row.windowId))
          for (const row of visible) {
            const id = idFor(agent, handle, row.windowId)
            if (dismissed.has(id)) continue
            let old = app.windows.get(row.windowId)
            const bounds = geometry(row.bounds)
            if (bounds) {
              const previousBounds = app.windowBounds.get(row.windowId)
              app.windowBounds.set(row.windowId, bounds)
              if (previousBounds && !sameGeometry(previousBounds, bounds) && old?.motion) { clearMotionTimer(id); const { motion: _motion, ...rest } = old; old = rest; app.windows.set(row.windowId, old); view.put(old) }
            }
            const size = app.windowSizes.get(row.windowId)
            app.windowSizes.set(row.windowId, { width: row.bounds.width, height: row.bounds.height })
            if (old && size && (size.width !== row.bounds.width || size.height !== row.bounds.height)) {
              view.invalidatePoint?.(id)
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
            view.invalidatePoint?.(old.id); clearPoint(old.id); clearMotionTimer(old.id)
            captures.get(old.id)?.abort(); captures.delete(old.id)
            const { point: _point, motion: _motion, ...withoutPoint } = old
            if (automatic.has(old.id)) {
              const count = (missing.get(old.id) ?? 0) + 1
              missing.set(old.id, count)
              if (count >= 3) { captured.delete(old.id); automatic.delete(old.id); missing.delete(old.id); app.windows.delete(windowId); app.captures.delete(windowId); view.remove(old.id) }
              else if (old.point) { app.windows.set(windowId, withoutPoint); view.put(withoutPoint) }
            } else if (!old.windowUnavailable || old.point) {
              const item = { ...withoutPoint, windowUnavailable: true }; app.windows.set(windowId, item); view.put(item)
            }
          }
          for (const windowId of app.windowSizes.keys()) if (!seen.has(windowId) && !app.windows.has(windowId)) app.windowSizes.delete(windowId)
        }
      }
      const eligible = candidates.filter(candidate => candidate.valid())
      refreshDelay = eligible.length ? Math.max(Math.min(250, intervalMs), intervalMs / eligible.length) : intervalMs
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
      const { point: _point, previewIssue: _previewIssue, ...rest } = old
      const nextBounds = geometry(shot.bounds)
      if (rest.motion && (!nextBounds || !sameGeometry(app.frameBounds.get(target.window), nextBounds))) { delete rest.motion; clearMotionTimer(old.id) }
      const image = `data:${shot.mimeType};base64,${shot.data}`
      const item = { ...rest, image, capturedAt: Date.now(), previewUnavailable: false, windowUnavailable: false }
      if (shot.bounds) {
        app.captures.set(target.window, { image, width: shot.bounds.width, height: shot.bounds.height })
        app.windowSizes.set(target.window, { width: shot.bounds.width, height: shot.bounds.height })
        const bounds = geometry(shot.bounds); if (bounds) app.frameBounds.set(target.window, bounds); else app.frameBounds.delete(target.window)
      }
      app.windows.set(target.window, item); view.put(item); applyPendingVisual(target.agent, target.handle, target.window)
    } catch (error) {
      if (!controller.signal.aborted && !closed) {
        const code = record(error)?.code
        if (code !== 'NATIVE_BUSY' && code !== 'NATIVE_CANCELLED') {
          console.warn('[perse-cua] Background preview failed:', typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN')
          const app = current && owners.get(current.agent)?.get(current.handle)
          const old = current && app?.windows.get(current.window)
          if (old && app && current?.valid()) {
            const kind = failureKind(code)
            const issue: PreviewWindow['previewIssue'] = code === 'PERMISSION_DENIED' ? 'screenRecording' : code === 'WINDOW_UNAVAILABLE' ? 'window' : code === 'CAPTURE_BUSY' || kind === 'timeout' ? 'busy' : kind === 'connection' ? 'connection' : undefined
            if (code === 'PERMISSION_DENIED') permissionBlocked.add(current.agent.id)
            if (kind === 'connection' || kind === 'application') invalidateFrames(current.agent, current.handle, kind, 'previewUnavailable', issue)
            else {
              const { point: _point, ...withoutPoint } = old
              const { image: _image, capturedAt: _capturedAt, ...withoutImage } = withoutPoint
              clearPoint(old.id); app.captures.delete(current.window)
              const item = { ...(kind === 'timeout' ? withoutPoint : withoutImage), previewUnavailable: true, ...(issue ? { previewIssue: issue } : {}) }; app.windows.set(current.window, item); view.put(item)
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
  const detachToolSignal = (exec: object): void => {
    const entry = toolSignals.get(exec)
    if (entry) entry.signal.removeEventListener('abort', entry.stop)
    toolSignals.delete(exec)
  }
  const stopCaptures = (id: string): void => {
    schedule(true, id)
    for (const [windowId, controller] of captures) if (windowId.startsWith(`${encodeURIComponent(id)}/`)) { controller.abort(); captures.delete(windowId) }
  }
  const finishTurn = (id: string, status: NonNullable<PreviewWindow['activity']>): void => {
    if (!activeTurns.delete(id)) return
    paused.set(id, status)
    clearPendingSession(id)
    stopCaptures(id)
    for (const [windowId, entry] of toolSignals) if (entry.id === id) detachToolSignal(windowId)
    for (const [agent, apps] of owners) if (agent.id === id) for (const app of apps.values()) for (const [windowId, item] of app.windows) {
      clearPoint(item.id)
      clearMotionTimer(item.id)
      const { point: _point, motion: _motion, ...rest } = item
      const ended = { ...rest, working: false, activity: status }; app.windows.set(windowId, ended); view.put(ended)
    }
  }
  const stopTurns = ctx.on('session/event', (session, event) => {
    const id = session.id
    if (event.type === 'turn/start') { pendingTurns.add(id); turnVersions.set(id, {}); return }
    if (event.type !== 'turn/end') return
    pendingTurns.delete(id)
    finishTurn(id, event.data.reason.kind === 'completed' ? 'completed' : event.data.reason.kind === 'aborted' ? 'stopped' : 'failed')
    turnVersions.delete(id)
  })
  const stopToolSignals = ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'cua' && exec.agent && !disposed.has(exec.agent) && !closed) {
      const id = exec.agent.id
      for (const [prior, entry] of toolSignals) if (entry.id === id && entry.settled) detachToolSignal(prior)
      const version = turnVersions.get(id)
      if (version) { executionVersions.set(exec, version); activeTurns.add(id) }
      // A cancelled read does not end the turn or interrupt a separate preview.
      const method = record(exec.arguments)?.method
      const passiveRead = method === 'getCapabilities' || method === 'listApps' || method === 'findApps' || method === 'listWindows' || method === 'getState' || method === 'screenshot'
      const onAbort = (): void => { if (!passiveRead) {
        paused.set(id, 'stopped'); clearPendingSession(id); stopCaptures(id)
        for (const app of owners.get(exec.agent!)?.values() ?? []) for (const [windowId, item] of app.windows) if (item.motion) {
          clearMotionTimer(item.id); const { motion: _motion, ...rest } = item; app.windows.set(windowId, rest); view.put(rest)
        }
      } }
      toolSignals.set(exec, { id, signal: exec.signal, stop: onAbort, settled: false })
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) onAbort()
      else if (activeTurns.has(id)) { paused.delete(id); schedule() }
    }
    return next()
  })
  const stop = ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'cua' || !exec.agent || disposed.has(exec.agent)) return
    const signalEntry = toolSignals.get(exec)
    if (signalEntry) signalEntry.settled = true
    if (result.isError && typeof exec.callId === 'string') clearRequestVisual(exec.agent, exec.callId)
    const version = executionVersions.get(exec)
    if (exec.signal.aborted || (version && version !== turnVersions.get(exec.agent.id))) return
    const request = record(exec.arguments)
    let rawParams = request?.params
    if (typeof rawParams === 'string') { try { rawParams = JSON.parse(rawParams) } catch { return } }
    const params = record(rawParams)
    const method = request?.method
    if (typeof method !== 'string' || !params) return
    const agent = exec.agent
    if (paused.has(agent.id) && !pendingTurns.has(agent.id)) return
    if (pendingTurns.delete(agent.id)) {
      paused.delete(agent.id)
      for (const app of owners.get(agent)?.values() ?? []) for (const [windowId, item] of app.windows) {
        if (item.activity) { const { activity: _activity, ...resumed } = item; app.windows.set(windowId, resumed); view.put(resumed) }
      }
    }
    activeTurns.add(agent.id)
    if (permissionBlocked.delete(agent.id)) schedule()
    let apps = owners.get(agent)
    if (!apps) { apps = new Map(); owners.set(agent, apps) }
    const value = result.isError ? undefined : record(result.value)
    if (method === 'getApp' && typeof value?.appHandle === 'string') {
      const previous = apps.get(value.appHandle)
      if (previous) {
        if (typeof value.name === 'string') previous.name = value.name
      } else apps.set(value.appHandle, { name: typeof value.name === 'string' ? value.name : 'Application', windows: new Map(), snapshots: new Map(), modelImages: new Map(), observations: new Map(), windowSizes: new Map(), captures: new Map(), windowBounds: new Map(), frameBounds: new Map() })
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
        const completeBounds = geometry(window.bounds)
        if (completeBounds) {
          const previousBounds = app.windowBounds.get(windowId)
          app.windowBounds.set(windowId, completeBounds)
          const current = app.windows.get(windowId)
          if (previousBounds && !sameGeometry(previousBounds, completeBounds) && current?.motion) { clearMotionTimer(current.id); const { motion: _motion, ...rest } = current; app.windows.set(windowId, rest); view.put(rest) }
        }
        const size = app.windowSizes.get(windowId)
        const nextSize = typeof bounds?.width === 'number' && typeof bounds.height === 'number' ? { width: bounds.width, height: bounds.height } : undefined
        const resized = nextSize !== undefined && size !== undefined && (size.width !== nextSize.width || size.height !== nextSize.height)
        if (nextSize) app.windowSizes.set(windowId, nextSize)
        if (method === 'getState' && nextSize) app.observations.set(windowId, nextSize)
        const old = app.windows.get(windowId)
        if (!old) continue
        const title = [app.name, typeof window.title === 'string' ? window.title : ''].filter(Boolean).join(' · ')
        const unavailable = window.isOnScreen === false || window.onCurrentSpace === false
        if (resized || unavailable) { view.invalidatePoint?.(old.id); clearPoint(old.id); clearMotionTimer(old.id); captures.get(old.id)?.abort(); captures.delete(old.id) }
        if (resized) { clearPoint(old.id); app.captures.delete(windowId); app.modelImages.delete(windowId); if (method !== 'getState') app.observations.delete(windowId) }
        if (old.title !== title || !!old.windowUnavailable !== unavailable || resized) {
          const { windowUnavailable: _unavailable, point, motion, ...rest } = old
          const item = { ...rest, title, ...(!resized && !unavailable && point ? { point } : {}), ...(!resized && !unavailable && motion ? { motion } : {}), ...(unavailable ? { windowUnavailable: true } : {}), ...(resized ? { previewUnavailable: true } : {}) }
          app.windows.set(windowId, item); view.put(item)
        }
      }
      for (const [windowId, old] of app.windows) if (!seen.has(windowId) && !old.windowUnavailable) { view.invalidatePoint?.(old.id); clearPoint(old.id); clearMotionTimer(old.id); captures.get(old.id)?.abort(); captures.delete(old.id); const { point: _point, motion: _motion, ...rest } = old; const item = { ...rest, windowUnavailable: true }; app.windows.set(windowId, item); view.put(item) }
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
    if (result.isError) { delete item.image; delete item.capturedAt; delete item.motion; clearMotionTimer(id); app.frameBounds.delete(selected) }
    if (method === 'screenshot' && typeof value?.data === 'string' && typeof value.mimeType === 'string') {
      item.image = `data:${value.mimeType};base64,${value.data}`; item.capturedAt = Date.now(); item.previewUnavailable = false; item.windowUnavailable = false
      delete item.previewIssue
      const bounds = record(value.bounds)
      const frameBounds = geometry(value.bounds)
      if (item.motion && (!frameBounds || !sameGeometry(app.frameBounds.get(selected), frameBounds))) { delete item.motion; clearMotionTimer(id) }
      if (frameBounds) { app.frameBounds.set(selected, frameBounds); app.windowBounds.set(selected, frameBounds) } else app.frameBounds.delete(selected)
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
    app.windows.set(selected, item); view.put(item, !!item.point); if (!result.isError) applyPendingVisual(agent, handle, selected); else clearPendingVisual(id)
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
      const { point: _point, previewIssue: _previewIssue, ...rest } = latest
      const nextBounds = geometry(shot.bounds)
      if (rest.motion && (!nextBounds || !sameGeometry(app.frameBounds.get(selected), nextBounds))) { delete rest.motion; clearMotionTimer(id) }
      const next = { ...rest, image: `data:${shot.mimeType};base64,${shot.data}`, capturedAt: Date.now(), previewUnavailable: false, windowUnavailable: false }
      if (shot.bounds) {
        app.captures.set(selected, { image: next.image, width: shot.bounds.width, height: shot.bounds.height })
        app.windowSizes.set(selected, { width: shot.bounds.width, height: shot.bounds.height })
        const bounds = geometry(shot.bounds); if (bounds) app.frameBounds.set(selected, bounds); else app.frameBounds.delete(selected)
      }
      app.windows.set(selected, next); view.put(next); applyPendingVisual(agent, handle, selected)
    }).catch(error => {
      if (closed || controller.signal.aborted || captures.get(id) !== controller || disposed.has(agent)) return
      const latest = app.windows.get(selected)
      if (!latest) return
      const code = record(error)?.code
      console.warn('[perse-cua] Native preview capture failed:', typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN')
      const kind = failureKind(code)
      const issue: PreviewWindow['previewIssue'] = code === 'PERMISSION_DENIED' ? 'screenRecording' : code === 'WINDOW_UNAVAILABLE' ? 'window' : code === 'CAPTURE_BUSY' || kind === 'timeout' ? 'busy' : kind === 'connection' ? 'connection' : undefined
      if (code === 'PERMISSION_DENIED') permissionBlocked.add(agent.id)
      if (kind === 'connection' || kind === 'application') invalidateFrames(agent, handle, kind, 'previewUnavailable', issue)
      else {
        clearPoint(id); app.captures.delete(selected)
        const { point: _point, ...withoutPoint } = latest
        const { image: _image, capturedAt: _capturedAt, ...withoutImage } = withoutPoint
        const next = { ...(kind === 'timeout' ? withoutPoint : withoutImage), previewUnavailable: true, ...(issue ? { previewIssue: issue } : {}) }
        app.windows.set(selected, next); view.put(next)
      }
    }).finally(() => { if (captures.get(id) === controller) captures.delete(id) })
  })
  const stopAgent = ctx.on('agent/disposed', ({ agent }) => {
    disposed.add(agent)
    clearPendingSession(agent.id)
    for (const [exec, entry] of toolSignals) if (entry.id === agent.id) detachToolSignal(exec)
    turnVersions.delete(agent.id); activeTurns.delete(agent.id); pendingTurns.delete(agent.id); paused.delete(agent.id); permissionBlocked.delete(agent.id)
    for (const id of captured.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) captured.delete(id)
    clients.delete(agent); visualSequences.delete(agent); processes.delete(agent); lists.delete(agent); for (const id of dismissed) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { dismissed.delete(id); automatic.delete(id); appearances.delete(id); missing.delete(id) }; for (const id of automatic) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { automatic.delete(id); missing.delete(id) }; for (const id of appearances.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) appearances.delete(id); schedule(true, agent.id)
    for (const [id, controller] of captures) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { controller.abort(); captures.delete(id) }
    for (const id of pointTimers.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) clearPoint(id)
    for (const id of visualStarts.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) clearMotionTimer(id)
    const apps = owners.get(agent)
    if (apps) for (const [handle, app] of apps) { const statusId = `${encodeURIComponent(agent.id)}/${encodeURIComponent(handle)}/status`; unsupported.delete(statusId); discoveryStatus.delete(statusId); view.remove(statusId); for (const item of app.windows.values()) view.remove(item.id) }
    owners.delete(agent)
  })
  return {
    hooks: {
      onVisual,
      onConnectionReady: recordConnectionReady,
      onConnectionFailure: recordConnectionFailure,
      onClient: (agent, capture, list) => { if (!closed && !disposed.has(agent)) { if (clients.has(agent)) { clearPendingSession(agent.id); visualSequences.delete(agent); processes.delete(agent); for (const app of owners.get(agent)?.values() ?? []) { app.frameBounds.clear(); for (const [windowId, item] of app.windows) if (item.motion) { clearMotionTimer(item.id); const { motion: _motion, ...rest } = item; app.windows.set(windowId, rest); view.put(rest) } } }; clients.set(agent, capture); if (list) lists.set(agent, list) } },
    },
    close: () => { closed = true; if (refreshTimer) clearTimeout(refreshTimer); background?.abort(); watchers.clear(); watcherVersions.clear(); paused.clear(); pendingTurns.clear(); activeTurns.clear(); permissionBlocked.clear(); for (const exec of toolSignals.keys()) detachToolSignal(exec); turnVersions.clear(); captured.clear(); lists.clear(); dismissed.clear(); automatic.clear(); appearances.clear(); missing.clear(); unsupported.clear(); discoveryStatus.clear(); stop(); stopAgent(); stopTurns(); stopToolSignals(); for (const controller of captures.values()) controller.abort(); captures.clear(); for (const id of pointTimers.keys()) clearPoint(id); for (const id of visualStarts.keys()) clearMotionTimer(id); for (const id of pendingVisuals.keys()) clearPendingVisual(id); visualStarts.clear(); clients.clear(); visualSequences.clear(); processes.clear(); owners.clear() },
  }
}
