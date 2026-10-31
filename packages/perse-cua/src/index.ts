/**
 * Desktop automation for DSH. On macOS the default provider registers the
 * native `cua` tool. The MCP backend connects to an external cua-driver,
 * curates its tools, and projects results to the harness.
 *
 * @module perse-cua
 */

import { execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { curateTools, BASE_WASTE_TOOLS, CURSOR_EXPERIENCE_TOOLS, MINIMAL_ALLOW, minimalAllowWithCursor } from './curate.ts'
import { McpStdioClient, McpTransportError, type McpCallResult, type McpContentBlock, type McpTool } from './mcp.ts'
import { condenseDescription, trimAxMenuTree } from './trim.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PreviewService, type PreviewWindow } from './view.ts'
import { observeNative } from './native-preview.ts'
import { NativeConfigFields, resolveNativeConfig, Schema, startNative } from './native-mode.ts'
import type { Config as NativeConfig } from './native.ts'
export { PreviewService } from './view.ts'
export type { PreviewWindow } from './view.ts'

export const name = 'perse-cua'

/** The tools registry is the only hard dependency; everything else is lazy. */
export const inject = ['tools']

/** Plugin configuration, read from the loader row's `config` block. */
export interface Config extends Partial<NativeConfig> {
  /** Select the native macOS provider or the external MCP driver explicitly. */
  backend?: 'native' | 'mcp'
  /** Provide the preview service without starting a driver or registering its tools. */
  presenterOnly?: boolean
  /** cua-driver executable; defaults to `cua-driver` on PATH. */
  command?: string
  /** Arguments for the driver; defaults to `['mcp']`. */
  args?: string[]
  /** Environment overrides for the child process. */
  env?: Record<string, string>
  /** Server row name; sets the `mcp__<serverName>__<tool>` namespace. */
  serverName?: string
  /**
   * Bare tool names to keep. Omit to keep every advertised tool except `deny`.
   * Pass `MINIMAL_ALLOW` for the token-tight desktop-only cut.
   */
  allow?: string[]
  /** Bare tool names to drop; wins over `allow`. Default: 3 provable-waste tools (`bestExperience` on). */
  deny?: string[]
  /** Condense descriptions to their first sentence. Default `true`. */
  condenseDescriptions?: boolean
  /** Strip accessibility menu subtrees from rendered trees. Default `true`. */
  trimMenuTrees?: boolean
  /**
   * macOS best experience, on by default. Does two things:
   *
   * 1. keeps the four `*_agent_cursor_*` tools in front of the model — the visible
   *    agent cursor is how a background-driven app announces itself (Codex-style),
   *    so these are a capability, not waste;
   * 2. at boot, shows the agent cursor on this transport's session, so the user
   *    can watch where the agent works while their own mouse and focus stay free
   *    (unlabeled calls use the same transport lease). A failure degrades to
   *    "cursor hidden", never to a broken boot.
   *
   * Set `false` to restore the cursor-denying surface and skip the boot session.
   */
  bestExperience?: boolean
  /**
   * Explicit session label owning the best-experience cursor. By default the
   * transport's implicit session is used (correct for unlabeled forwarded calls);
   * set this only to pin a named session — note a fixed label that has ended on a
   * shared daemon stays bound to its old lease and can reject revival.
   */
  bestExperienceSession?: string
  /**
   * Menu-bar session indicator (macOS only; follows `bestExperience` when
   * omitted). A tiny LSUIElement app shipped in `bin/` shows an "assistive
   * session" status item at boot and restarts it on activity after it exits.
   */
  indicator?: boolean
  /** State file the indicator polls; defaults to ~/Library/Application Support/perse-cua/indicator.json. */
  indicatorStateFile?: string
  /** Show window previews in hosts with the Remote gateway and client slots. */
  drivingPanel?: boolean
  /** Interval between background native preview refreshes in milliseconds. */
  previewRefreshIntervalMs?: number
  /** Per-call timeout for driver tool calls, milliseconds. */
  requestTimeoutMs?: number
  /** Time budget for spawning the driver and completing the handshake. */
  startupTimeoutMs?: number
}

/** Loader schema retains the native provider's root-level application grants. */
export const Config = Schema.object({
  ...NativeConfigFields,
  backend: Schema.union([Schema.const('native'), Schema.const('mcp'), Schema.const(undefined)]),
  presenterOnly: Schema.boolean(), command: Schema.string(), args: Schema.union([Schema.array(Schema.string()), Schema.const(undefined)]),
  env: Schema.union([Schema.dict(Schema.string()), Schema.const(undefined)]), serverName: Schema.string(), allow: Schema.union([Schema.array(Schema.string()), Schema.const(undefined)]),
  deny: Schema.union([Schema.array(Schema.string()), Schema.const(undefined)]), condenseDescriptions: Schema.boolean(), trimMenuTrees: Schema.boolean(),
  bestExperience: Schema.boolean(), bestExperienceSession: Schema.string(), indicator: Schema.boolean(),
  indicatorStateFile: Schema.string(), drivingPanel: Schema.boolean(), requestTimeoutMs: Schema.number(),
  startupTimeoutMs: Schema.number(), previewRefreshIntervalMs: Schema.number().min(1000).max(60000).step(1),
})

/** Descriptions longer than this are trimmed to their first sentence. */
const DESCRIPTION_BUDGET = 200

/** Tools that only read, and may therefore run alongside another call. */
const READ_ONLY_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_screen_size',
  'get_accessibility_tree',
  'get_config',
  'health_report',
  'check_permissions',
  'clipboard_read',
])

/** Content block shape the harness accepts back from a tool render. */
type RenderBlock = { type: 'text'; text: string } | { type: 'image'; attachment: unknown }

/** Byte size of one wire tool definition as this plugin would register it. */
function definitionBytes(tool: McpTool, condense: boolean): number {
  const description = condense ? condenseDescription(tool.description ?? '', DESCRIPTION_BUDGET) : (tool.description ?? '')
  return Buffer.byteLength(JSON.stringify({ name: tool.name, description, parameters: tool.inputSchema ?? {} }))
}

/**
 * Register the curated surface and keep the driver alive for the plugin's life.
 *
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - loader row configuration; every field is optional.
 * @returns a disposer that unregisters every tool and stops the driver.
 */
export const apply = (ctx: Context & { tools: { register: (definition: unknown) => () => void }; logger?: { info: (message: string) => void } }, config: Config = {}): (() => void) => {
  const mcpFields = ['command', 'args', 'env', 'serverName', 'allow', 'deny', 'condenseDescriptions', 'trimMenuTrees', 'bestExperience', 'bestExperienceSession', 'indicator', 'indicatorStateFile', 'drivingPanel', 'requestTimeoutMs', 'startupTimeoutMs'] as const
  const hasMcpFields = mcpFields.some(key => config[key] !== undefined)
  if (config.presenterOnly !== true && config.backend === 'native' && process.platform !== 'darwin') throw new Error('perse-cua native requires macOS 14 or later')
  if (config.presenterOnly !== true && process.platform === 'darwin' && config.backend === undefined && hasMcpFields) {
    throw new Error('perse-cua MCP driver settings require backend: mcp explicitly on macOS')
  }
  if (config.presenterOnly !== true && config.backend === 'native' && hasMcpFields) throw new Error('perse-cua native backend cannot use MCP driver settings')
  const view = new PreviewService(ctx)
  if (config.presenterOnly === true) return () => view.close()
  if (config.backend === 'native' || (process.platform === 'darwin' && config.backend === undefined)) {
    try {
      const { allowedApps: _allowedApps, ...rawConfig } = config
      const nativeConfig = config.allowedApps === undefined ? resolveNativeConfig(rawConfig) : config as NativeConfig
      const preview = observeNative(ctx, view, { intervalMs: config.previewRefreshIntervalMs })
      try { startNative(ctx, nativeConfig, preview.hooks) } catch (error) { preview.close(); throw error }
      return () => { preview.close(); view.close() }
    } catch (error) { view.close(); throw error }
  }
  const serverName = config.serverName ?? 'cua'
  const prefix = `mcp__${serverName}__`
  const condense = config.condenseDescriptions !== false
  const trimTrees = config.trimMenuTrees !== false
  const bestExperience = config.bestExperience !== false
  let cursorSession: string | undefined
  let cursorSessionOpen = false

  const client = new McpStdioClient({
    command: config.command ?? 'cua-driver',
    args: config.args ?? ['mcp'],
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: config.startupTimeoutMs }),
    onStderr: (line) => console.log(`[perse-cua] cua-driver: ${line}`),
  })

  const disposers: Array<() => void> = []
  let started = false

  /**
   * The allow/deny actually applied, given `bestExperience`. Cursor tools are waste
   * only when the cursor is invisible; with best experience on they stay in the
   * surface, and a `MINIMAL_ALLOW` profile gets them unioned back in so a
   * token-tight row still shows the cursor. A custom `allow` list is respected
   * verbatim; an explicit `deny` always wins (curateTools precedence).
   */
  const resolvePolicy = (): { allow: readonly string[] | undefined; deny: readonly string[] } => {
    const deny = config.deny ?? (bestExperience ? BASE_WASTE_TOOLS : [...BASE_WASTE_TOOLS, ...CURSOR_EXPERIENCE_TOOLS])
    const allow = config.allow
    if (allow === undefined) return { allow: undefined, deny }
    if (bestExperience && allow.length === MINIMAL_ALLOW.length && MINIMAL_ALLOW.every(name => allow.includes(name))) {
      return { allow: minimalAllowWithCursor(), deny }
    }
    return { allow, deny }
  }

  /** Enable the cursor on the transport's implicit session or the configured named session. */
  const enableBestExperienceCursor = async (): Promise<void> => {
    try {
      const session = config.bestExperienceSession
      const args = session === undefined ? {} : { session }
      const startedSession = await client.callTool('start_session', args)
      if (startedSession.isError === true) throw new Error('start_session was refused')
      cursorSession = session
      cursorSessionOpen = session !== undefined
      const enabled = await client.callTool('set_agent_cursor_enabled', { ...args, enabled: true })
      if (enabled.isError === true) throw new Error('set_agent_cursor_enabled was refused')
      console.log(`[perse-cua] best experience: agent cursor on (${session === undefined ? 'implicit transport session' : `session "${session}"`})`)
    } catch (error: unknown) {
      console.log(`[perse-cua] best experience cursor unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Menu-bar session indicator (macOS only). The helper app must be launched via
   * `open` — LaunchServices-registered apps are the only ones whose NSStatusItem
   * renders — so state flows through a small JSON file the helper polls, with
   * TTL decay and self-cleanup on file removal. Everything is best-effort: a
   * missing helper degrades to "no indicator", never to a broken boot.
   */
  const indicatorEnabled = config.indicator ?? bestExperience
  const stateFile = config.indicatorStateFile
    ?? path.join(homedir(), 'Library', 'Application Support', 'perse-cua', 'indicator.json')
  let indicatorLaunched = false
  let indicatorClosed = false
  let indicatorProcess: ChildProcess | undefined
  let indicatorActivity = 0
  let indicatorStateWritten = false
  let indicatorTimer: ReturnType<typeof setTimeout> | undefined
  let lastStateWrite = 0
  let lastStateActive = false
  const writeIndicatorState = (active: boolean): void => {
    if (indicatorClosed) return
    try {
      writeFileSync(stateFile, JSON.stringify({ session: cursorSession ?? 'perse-cua', active, ts: Date.now() / 1000 }))
      indicatorStateWritten = true
      lastStateWrite = Date.now()
      lastStateActive = active
    } catch {
      // The indicator is cosmetic; never fail a call over it.
    }
  }
  const launchIndicator = (): void => {
    if (!indicatorEnabled || indicatorClosed || indicatorLaunched || process.platform !== 'darwin') return
    indicatorLaunched = true
    const launchedAtActivity = indicatorActivity
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true })
    } catch {
      // fall through; the state write reports real trouble
    }
    writeIndicatorState(lastStateActive)
    const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'PerseCuaIndicator.app')
    try {
      // Wait for the app itself to exit, including its idle timeout. An ordinary
      // `open` exits as soon as the launch is accepted and cannot track liveness.
      const launcher = execFile('open', ['-g', '-W', app, '--args', stateFile], () => {
        if (indicatorProcess !== launcher) return
        indicatorProcess = undefined
        indicatorLaunched = false
        if (!indicatorClosed && indicatorActivity > launchedAtActivity) launchIndicator()
      })
      indicatorProcess = launcher
    } catch {
      indicatorLaunched = false
    }
  }
  const noteIndicatorActivity = (rawName: string): void => {
    if (indicatorClosed || READ_ONLY_TOOLS.has(rawName)) return
    indicatorActivity += 1
    launchIndicator()
    if (!indicatorLaunched) return
    // Always claim the first action after idle; throttle only consecutive actives.
    if (!lastStateActive || Date.now() - lastStateWrite > 1000) writeIndicatorState(true)
    if (indicatorTimer !== undefined) clearTimeout(indicatorTimer)
    indicatorTimer = setTimeout(() => {
      indicatorTimer = undefined
      writeIndicatorState(false)
    }, 2500)
  }
  const closeIndicator = (): void => {
    indicatorClosed = true
    if (indicatorTimer !== undefined) {
      clearTimeout(indicatorTimer)
      indicatorTimer = undefined
    }
    if (indicatorStateWritten) {
      try {
        rmSync(stateFile) // the helper polls itself out of existence
      } catch {
        // already gone
      }
    }
    // The helper observes the missing file independently of the open waiter.
    // Reap the waiter now so disposal does not keep the host process alive.
    const launcher = indicatorProcess
    indicatorProcess = undefined
    indicatorLaunched = false
    launcher?.kill()
  }

  const disposedAgents = new WeakSet<Agent>()
  const stopAgentListener = ctx.on('agent/disposed', ({ agent }) => {
    disposedAgents.add(agent)
    for (const id of previews.keys()) if (id.startsWith(`${encodeURIComponent(agent.id)}/`)) { clearPointTimer(id); previews.delete(id); view.remove(id) }
    for (const key of snapshots.keys()) if (key.startsWith(`${encodeURIComponent(agent.id)}/`)) snapshots.delete(key)
    for (const key of captures.keys()) if (key.startsWith(`${encodeURIComponent(agent.id)}/`)) captures.delete(key)
  })
  const previews = new Map<string, { item: PreviewWindow; revision: number }>()
  const snapshots = new Map<string, { pid: number; windowId: number }>()
  const captures = new Map<string, { pid: number; windowId: number; image: string; width: number; height: number; capturedAt: number; verified: boolean }>()
  const pointTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearPointTimer = (id: string): void => { const timer = pointTimers.get(id); if (timer !== undefined) clearTimeout(timer); pointTimers.delete(id) }
  let viewClosed = false
  let revision = 0
  view.setDismissHandler(id => { clearPointTimer(id); previews.delete(id) })
  const observe = (rawName: string, args: Record<string, unknown>, result: McpCallResult, agent: Agent | undefined, working = false, started?: { id: string; revision: number }): { id: string; revision: number } | undefined => {
    if (!(config.drivingPanel ?? bestExperience) || viewClosed || agent === undefined || disposedAgents.has(agent)) return
    if (rawName === 'end_session' && !working && result.isError !== true) {
      const key = `${encodeURIComponent(agent.id)}/${encodeURIComponent(typeof args.session === 'string' ? args.session : '')}/`
      for (const id of previews.keys()) if (id.startsWith(key)) { clearPointTimer(id); previews.delete(id); view.remove(id) }
      for (const entry of snapshots.keys()) if (entry.startsWith(key)) snapshots.delete(entry)
      for (const entry of captures.keys()) if (entry.startsWith(key)) captures.delete(entry)
      if (typeof args.session === 'string') cursorSessions.delete(args.session)
      return
    }
    const session = typeof args.session === 'string' ? args.session : ''
    const owner = `${encodeURIComponent(agent.id)}/${encodeURIComponent(session)}/`
    const token = typeof args.element_token === 'string' ? args.element_token.split(':')[0] : undefined
    const previousSnapshot = token ? snapshots.get(`${owner}${token}`) : undefined
    const target = args.target !== null && typeof args.target === 'object' ? args.target as Record<string, unknown> : undefined
    const pid = typeof args.pid === 'number' ? args.pid : target?.kind === 'window' && typeof target.pid === 'number' ? target.pid : previousSnapshot?.pid
    const windowId = typeof args.window_id === 'number' ? args.window_id : target?.kind === 'window' && typeof target.window_id === 'number' ? target.window_id : previousSnapshot?.windowId
    if (pid === undefined || windowId === undefined) return
    const id = `${owner}${pid}/${windowId}`
    if (started !== undefined && (started.id !== id || previews.get(id)?.revision !== started.revision)) return
    const old = previews.get(id)?.item
    const metadata = result.structuredContent !== null && typeof result.structuredContent === 'object' ? result.structuredContent as Record<string, unknown> : {}
    const app = typeof metadata.app_name === 'string' ? metadata.app_name : ''
    const tree = result.content.find(block => block.type === 'text')?.text ?? ''
    const snapshot = typeof metadata.snapshot_id === 'string' ? metadata.snapshot_id : /snapshot_id=([^\s]+)/.exec(tree)?.[1]
    if (rawName === 'get_window_state' && snapshot && result.isError !== true) {
      snapshots.set(`${owner}${snapshot}`, { pid, windowId })
      while (snapshots.size > 128) { const first = snapshots.keys().next().value; if (first === undefined) break; snapshots.delete(first) }
    }
    const title = typeof metadata.window_title === 'string' ? metadata.window_title : /AXWindow\s+"([^"]+)"/.exec(tree)?.[1] ?? ''
    const image = rawName === 'get_window_state' ? result.content.find(block => block.type === 'image' && block.data) : undefined
    const receivedAt = Date.now()
    if (!working && rawName === 'get_window_state' && result.isError !== true && image?.data && typeof metadata.capture_id === 'string' && typeof metadata.screenshot_width === 'number' && metadata.screenshot_width > 0 && typeof metadata.screenshot_height === 'number' && metadata.screenshot_height > 0) {
      captures.set(`${owner}${metadata.capture_id}`, { pid, windowId, image: `data:${image.mimeType ?? 'image/png'};base64,${image.data}`, width: metadata.screenshot_width, height: metadata.screenshot_height, capturedAt: receivedAt, verified: false })
      while (captures.size > 128) { const first = captures.keys().next().value; if (first === undefined) break; captures.delete(first) }
    }
    const captured = typeof args.capture_id === 'string' ? captures.get(`${owner}${args.capture_id}`) : undefined
    const effect = metadata.effect
    const point = !working && rawName === 'click' && result.isError !== true && (effect === 'confirmed' || effect === 'unverifiable') && captured?.verified === true && captured.pid === pid && captured.windowId === windowId && typeof args.x === 'number' && typeof args.y === 'number' && args.x >= 0 && args.y >= 0 && args.x <= captured.width && args.y <= captured.height ? { x: args.x / captured.width, y: args.y / captured.height } : undefined
    if (!working && typeof args.capture_id === 'string') captures.delete(`${owner}${args.capture_id}`)
    const item: PreviewWindow = { id, title: [app, title].filter(Boolean).join(' · ') || old?.title || `Window ${windowId}`, action: rawName, ...(working ? { working: true } : {}), ...(result.isError === true ? { failed: true } : {}), ...(old?.windowUnavailable ? { windowUnavailable: true } : {}), ...(old?.previewUnavailable ? { previewUnavailable: true } : {}), ...(point && captured ? { image: captured.image, capturedAt: captured.capturedAt, point } : old?.image ? { image: old.image, ...(old.capturedAt === undefined ? {} : { capturedAt: old.capturedAt }) } : {}) }
    clearPointTimer(id)
    const current = ++revision
    previews.set(id, { item, revision: current })
    view.put(item)
    if (point) {
      pointTimers.set(id, setTimeout(() => {
        pointTimers.delete(id)
        const latest = previews.get(id)
        if (viewClosed || latest?.revision !== current) return
        const { point: _point, ...rest } = latest.item
        latest.item = rest
        view.put(rest)
      }, 900))
    }
    if (working) return { id, revision: current }
    if (result.isError === true) return
    void (async () => {
      try {
        const shot = await client.callTool('get_window_state', { ...(session ? { session } : {}), pid, window_id: windowId, include_screenshot: true, include_accessibility_tree: false, display_only: true, max_image_dimension: 0 })
        const listing = await client.callTool('list_windows', { ...(session ? { session } : {}), pid })
        const status = windowVisibility(listing, windowId)
        const latest = previews.get(id)
        const picture = shot.content.find(block => block.type === 'image' && block.data)
        if (viewClosed || latest?.revision !== current) return
        if (status !== 'visible') {
          const { point: _point, ...rest } = latest.item; clearPointTimer(id)
          latest.item = { ...rest, ...(status === 'unavailable' ? { windowUnavailable: true } : { previewUnavailable: true }) }
          for (const entry of captures.values()) if (entry.pid === pid && entry.windowId === windowId) entry.verified = false
          view.put(latest.item); return
        }
        if (typeof metadata.capture_id === 'string') { const candidate = captures.get(`${owner}${metadata.capture_id}`); if (candidate?.pid === pid && candidate.windowId === windowId) candidate.verified = true }
        if (shot.isError || !picture?.data) { const { point: _point, ...rest } = latest.item; clearPointTimer(id); latest.item = { ...rest, previewUnavailable: true }; view.put(latest.item); return }
        const shotMetadata = shot.structuredContent !== null && typeof shot.structuredContent === 'object' ? shot.structuredContent as Record<string, unknown> : {}
        const shotTree = shot.content.find(block => block.type === 'text')?.text ?? ''
        const shotTitle = typeof shotMetadata.window_title === 'string' ? shotMetadata.window_title : /AXWindow\s+"([^"]+)"/.exec(shotTree)?.[1]
        const shotApp = typeof shotMetadata.app_name === 'string' ? shotMetadata.app_name : ''
        clearPointTimer(id)
        const { previewUnavailable: _unavailable, windowUnavailable: _windowUnavailable, point: _point, ...present } = latest.item
        latest.item = { ...present, ...(shotTitle ? { title: [shotApp, shotTitle].filter(Boolean).join(' · ') } : {}), image: `data:${picture.mimeType ?? 'image/png'};base64,${picture.data}`, capturedAt: Date.now() }
        view.put(latest.item)
      } catch (error) {
        const latest = previews.get(id)
        if (!viewClosed && latest?.revision === current) { const { point: _point, ...rest } = latest.item; clearPointTimer(id); latest.item = { ...rest, previewUnavailable: true }; view.put(latest.item); console.warn('[perse-cua] preview capture failed:', error) }
      }
    })()
  }
  const closeDrivingPanel = (): void => { viewClosed = true; stopAgentListener(); for (const timer of pointTimers.values()) clearTimeout(timer); pointTimers.clear(); previews.clear(); snapshots.clear(); captures.clear(); view.close() }

  const cursorSessions = new Map<string, Promise<void>>()
  const ensureCursor = (session: string): Promise<void> => {
    let pending = cursorSessions.get(session)
    if (pending === undefined) {
      pending = client.callTool('set_agent_cursor_enabled', { session, enabled: true }).then(result => {
        if (result.isError) throw new Error('cursor enable was refused')
      }).catch(error => { cursorSessions.delete(session); console.warn('[perse-cua] cursor unavailable:', error) })
      cursorSessions.set(session, pending)
    }
    return pending
  }

  const boot = async (): Promise<void> => {
    await client.start()
    const advertised = await client.listTools()
    if (viewClosed) return
    const policy = resolvePolicy()
    const curation = curateTools(advertised.map(tool => tool.name), policy.allow, policy.deny)
    const byName = new Map(advertised.map(tool => [tool.name, tool]))

    if (bestExperience) await enableBestExperienceCursor()
    if (viewClosed) return
    let before = 0
    let after = 0
    let trimmed = 0

    for (const tool of advertised) {
      before += definitionBytes(tool, false)
      if (!curation.keep.includes(tool.name)) continue
      const afterBytes = definitionBytes(tool, condense)
      after += afterBytes
      if (afterBytes < definitionBytes(tool, false)) trimmed += 1
      disposers.push(registerTool(ctx, client, tool, prefix, condense, trimTrees,
        bestExperience ? () => cursorSession : undefined, (name: string) => noteIndicatorActivity(name),
        observe, bestExperience ? ensureCursor : undefined))
    }

    started = true
    console.log(
      `[perse-cua] ${String(advertised.length)} tools advertised → ${String(curation.keep.length)} registered `
      + `(${String(curation.drop.length)} curated out, ${String(trimmed)} descriptions condensed); `
      + `schema ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB`,
    )
    if (curation.unmatched.length > 0) {
      console.log(`[perse-cua] allow-list entries matching no advertised tool: ${curation.unmatched.join(', ')}`)
    }
    if (byName.size === 0) console.log('[perse-cua] cua-driver advertised no tools')

    launchIndicator()
  }

  boot().catch((error: unknown) => {
    const reason = error instanceof McpTransportError ? error.message : String(error)
    console.error(`[perse-cua] bridging cua-driver failed: ${reason}`)
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A failed unregister must not block the remaining cleanups.
      }
    }
    disposers.length = 0
    if (started && cursorSessionOpen) {
      client.callTool('end_session', { session: cursorSession }).catch(() => {
        // Best-effort cleanup; closing the transport ends the lease anyway.
      })
    }
    closeIndicator()
    closeDrivingPanel()
    client.close()
  }
}

/** Read only explicit WindowServer visibility, never infer it from the AX tree. */
function windowVisibility(result: McpCallResult, windowId: number): 'visible' | 'unavailable' | 'unknown' {
  if (result.isError === true) return 'unknown'
  const data = result.structuredContent
  if (data !== null && typeof data === 'object' && Array.isArray((data as { windows?: unknown }).windows)) {
    const windows = (data as { windows: unknown[] }).windows
    const entry = windows.find(row => row !== null && typeof row === 'object' && (row as { window_id?: unknown }).window_id === windowId)
    if (entry === undefined) return 'unavailable'
    const visible = (entry as { is_on_screen?: unknown }).is_on_screen
    return visible === true ? 'visible' : visible === false ? 'unavailable' : 'unknown'
  }
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  if (!/^Found \d+ window\(s\)\./m.test(text)) return 'unknown'
  const row = text.split('\n').find(line => line.includes(`[window_id: ${String(windowId)}]`))
  return row === undefined ? 'unavailable' : row.includes('[off-screen]') ? 'unavailable' : 'visible'
}

/** Tools that manage sessions themselves; never inject a session into them. */
const SESSION_LIFECYCLE = new Set([
  'start_session', 'end_session', 'get_session', 'list_sessions', 'get_session_state',
  'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme', 'get_agent_cursor_state',
])

/** Whether a driver tool's schema accepts a `session` argument. */
function acceptsSession(tool: McpTool): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
  return props !== undefined && Object.prototype.hasOwnProperty.call(props, 'session')
}

/** Register one cua-driver tool under the harness namespace. */
function registerTool(
  ctx: { tools: { register: (definition: unknown) => () => void }; get: (name: string) => unknown },
  client: McpStdioClient,
  tool: McpTool,
  prefix: string,
  condense: boolean,
  trimTrees: boolean,
  cursorFor?: () => string | undefined,
  onCall?: (rawName: string) => void,
  onExecuted?: (rawName: string, callArgs: Record<string, unknown>, result: McpCallResult, agent: Agent | undefined, working?: boolean, started?: { id: string; revision: number }) => { id: string; revision: number } | undefined,
  ensureCursor?: (session: string) => Promise<void>,
): () => void {
  const rawName = tool.name
  const truncated = condense ? condenseDescription(tool.description ?? '', DESCRIPTION_BUDGET) : (tool.description ?? '')
  const description = truncated === '' ? `cua-driver ${rawName}` : truncated

  return ctx.tools.register({
    name: `${prefix}${rawName}`,
    description,
    parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): RenderBlock[] => {
        const blocks = (value as { blocks?: RenderBlock[] } | undefined)?.blocks
        return blocks ?? [{ type: 'text', text: 'cua-driver returned no content' }]
      },
    },
    isConcurrencySafe: () => READ_ONLY_TOOLS.has(rawName),
    async execute(args: unknown, exec?: { agent?: Agent }): Promise<{ blocks: RenderBlock[] }> {
      onCall?.(rawName)
      let callArgs: Record<string, unknown> = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
      // Best experience: unlabeled calls would act through the implicit lease, whose
      // cursor nobody enabled. Route them through the cursor session so the overlay
      // animates — Codex-style — while still letting the model override `session`.
      if (cursorFor !== undefined && callArgs.session === undefined && acceptsSession(tool) && !SESSION_LIFECYCLE.has(rawName)) {
        const cursorSession = cursorFor()
        if (cursorSession !== undefined) callArgs = { session: cursorSession, ...callArgs }
      }
      if (!SESSION_LIFECYCLE.has(rawName) && typeof callArgs.session === 'string') await ensureCursor?.(callArgs.session)
      const started = onExecuted?.(rawName, callArgs, { content: [] }, exec?.agent, true)
      let result: McpCallResult
      try { result = await client.callTool(rawName, callArgs) } catch (error) {
        onExecuted?.(rawName, callArgs, { content: [], isError: true }, exec?.agent, false, started)
        throw error
      }
      onExecuted?.(rawName, callArgs, result, exec?.agent, false, started)
      const blocks = await project(ctx, result, trimTrees)
      if (result.isError === true) {
        const text = blocks.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('\n')
        throw new Error(text === '' ? `cua-driver ${rawName} failed` : text)
      }
      return { blocks }
    },
  })
}

/**
 * Turn one MCP result into harness content blocks.
 *
 * Text keeps the driver's bytes except for an optional menu-subtree removal.
 * Images are stored through the attachment service exactly as the harness bridge
 * does; when no store is mounted, or admission fails, the image degrades to the
 * same diagnostic line the bridge uses rather than dropping the result.
 */
async function project(
  ctx: { get: (name: string) => unknown },
  result: McpCallResult,
  trimTrees: boolean,
): Promise<RenderBlock[]> {
  const blocks: RenderBlock[] = []
  const attachments = ctx.get('attachments') as { saveImages?: (images: Array<{ data: Buffer; mediaType: string }>) => Promise<unknown[]> } | undefined

  for (const block of result.content as readonly McpContentBlock[]) {
    if (block.type === 'text') {
      const text = block.text ?? ''
      if (!trimTrees) {
        blocks.push({ type: 'text', text })
        continue
      }
      const { text: trimmedText, droppedLines, droppedBlocks } = trimAxMenuTree(text)
      if (droppedBlocks > 0) console.log(`[perse-cua] trimmed ${String(droppedLines)} menu lines (${String(droppedBlocks)} block(s))`)
      blocks.push({ type: 'text', text: trimmedText })
      continue
    }
    if (block.type === 'image') {
      const admitted = await admitImage(attachments, block)
      blocks.push(admitted)
      continue
    }
    blocks.push({ type: 'text', text: `[${block.type} content omitted by perse-cua]` })
  }

  if (result.structuredContent !== null && typeof result.structuredContent === 'object') {
    const data = result.structuredContent as Record<string, unknown>
    if (typeof data.capture_id === 'string' && typeof data.screenshot_width === 'number' && typeof data.screenshot_height === 'number') {
      blocks.push({ type: 'text', text: `Screenshot coordinates: ${JSON.stringify({ capture_id: data.capture_id, width: data.screenshot_width, height: data.screenshot_height })}` })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: 'cua-driver returned no content' })
  return blocks
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Decode and durably store one image block, or explain why it is text instead. */
async function admitImage(
  attachments: { saveImages?: (images: Array<{ data: Buffer; mediaType: string }>) => Promise<unknown[]> } | undefined,
  block: McpContentBlock,
): Promise<RenderBlock> {
  const mediaType = block.mimeType ?? 'unknown media type'
  const diagnostic = (reason: string): RenderBlock => ({
    type: 'text',
    text: `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`,
  })
  if (block.mimeType === undefined || !IMAGE_TYPES.has(block.mimeType)) return diagnostic('the declared media type is not PNG, JPEG, WebP, or GIF')
  if (block.data === undefined || !BASE64.test(block.data)) return diagnostic('the image data is not canonical base64')
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) return diagnostic('the image data is not canonical base64')
  if (attachments?.saveImages === undefined) return diagnostic('no attachment store is mounted')
  try {
    const refs = await attachments.saveImages([{ data, mediaType: block.mimeType }])
    const ref = refs[0]
    if (ref === undefined) return diagnostic('durable image storage returned no reference')
    return { type: 'image', attachment: ref }
  } catch {
    return diagnostic('durable image storage rejected the result')
  }
}

export {
  curateTools, bareToolName, DEFAULT_ALLOW, DEFAULT_DENY, MINIMAL_ALLOW,
  WASTE_ONLY_TOOLS, BASE_WASTE_TOOLS, CURSOR_EXPERIENCE_TOOLS, minimalAllowWithCursor,
} from './curate.ts'
export { trimAxMenuTree, condenseDescription } from './trim.ts'
export type { McpTool } from './mcp.ts'
