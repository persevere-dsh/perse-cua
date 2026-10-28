/**
 * `perse-cua` — put cua-driver's desktop-automation tools in front of the model
 * without paying for the parts a session never uses.
 *
 * Why this exists rather than a plain `dsh-mcp-client` row: cua-driver 0.28.1
 * advertises 56 tools whose model-facing schema (name + description +
 * inputSchema) measured 93 KB — roughly 23K tokens attached to *every* request,
 * whether or not the task touches the GUI. Two thirds of that is prose the model
 * does not need inline, because the full operating procedure already ships as the
 * `cua-driver` skill and can be loaded on demand. This plugin therefore:
 *
 * 1. curates the surface to the desktop-automation loop (`curate.ts`);
 * 2. condenses each tool description to its first sentence, leaving the schema
 *    untouched so every parameter still validates;
 * 3. strips the accessibility menu bar out of rendered trees (`trim.ts`), which
 *    on a small window is ~84% of the lines and never an automation target;
 * 4. turns on the macOS best experience by default (`bestExperience`): the four
 *    agent-cursor tools stay in the surface and a named session shows the visible
 *    agent cursor at boot — Codex-style background driving the user can watch.
 *
 * It owns the MCP connection itself instead of wrapping `dsh-mcp-client` because
 * the harness exposes no result-projection hook: `tools.restrict()` requires an
 * agent-scoped context and cannot mask a surface at plugin load, and the generic
 * bridge renders straight from the MCP text.
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

export const name = 'perse-cua'

/** The tools registry is the only hard dependency; everything else is lazy. */
export const inject = ['tools']

/** Plugin configuration, read from the loader row's `config` block. */
export interface Config {
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
   *    (forwarded calls carry no session label and act through the same implicit
   *    lease, so its cursor is the one that animates). A failure degrades to
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
   * session" status item at boot, brightening while non-read-only tools run.
   * After the helper exits (including its idle timeout), the next non-read-only
   * call restarts it. Startup failure never blocks a driver tool call.
   */
  indicator?: boolean
  /** State file the indicator polls; defaults to ~/Library/Application Support/perse-cua/indicator.json. */
  indicatorStateFile?: string
  /**
   * Driving view (follows `bestExperience` when omitted): while tools drive a
   * window, upserts an in-app panel (DSH's `panels` service) showing that
   * window's live thumbnail plus an action caption — draggable by the user,
   * auto-removed when driving goes idle. No-op when the host lacks panels.
   */
  drivingPanel?: boolean
  /** Per-call timeout for driver tool calls, milliseconds. */
  requestTimeoutMs?: number
  /** Time budget for spawning the driver and completing the handshake. */
  startupTimeoutMs?: number
}

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
export function apply(ctx: { tools: { register: (definition: unknown) => () => void }; get: (name: string) => unknown; logger?: { info: (message: string) => void } }, config: Config = {}): () => void {
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

  /**
   * Show the agent cursor (Codex-style: the user sees where the agent works;
   * their own pointer and focus stay free).
   *
   * The session that owns the cursor is, in order:
   *
   * 1. `bestExperienceSession` when configured (explicit label);
   * 2. the transport's **implicit session** — right, because tool calls this
   *    plugin forwards carry no session label and therefore act through the
   *    implicit lease, so its cursor is the one that animates;
   * 3. a fresh unique named session as a last resort (never a fixed default:
   *    an ended name stays bound to its dead lease on a shared daemon and
   *    would reject revival from a new transport).
   *
   * Any failure degrades to the cursor staying hidden — never to a broken boot.
   */
  const enableBestExperienceCursor = async (): Promise<void> => {
    try {
      if (config.bestExperienceSession !== undefined) {
        await client.callTool('start_session', { session: config.bestExperienceSession })
        cursorSession = config.bestExperienceSession
        cursorSessionOpen = true
      } else {
        try {
          const res = await client.callTool('start_session', {})
          const text = res.content.find(block => block.type === 'text')?.text
          const parsed: unknown = text === undefined ? undefined : JSON.parse(text)
          const implicit = typeof parsed === 'object' && parsed !== null && typeof (parsed as { session?: unknown }).session === 'string'
            ? (parsed as { session: string }).session
            : undefined
          if (implicit !== undefined) {
            cursorSession = implicit // implicit lease ends with the transport; nothing to clean up
          } else {
            throw new Error('start_session returned no implicit session name')
          }
        } catch {
          cursorSession = `perse-cua-${String(process.pid)}-${Date.now().toString(36)}`
          await client.callTool('start_session', { session: cursorSession })
          cursorSessionOpen = true
        }
      }
      await client.callTool('set_agent_cursor_enabled', { session: cursorSession, enabled: true })
      console.log(`[perse-cua] best experience: agent cursor on (session "${cursorSession}")`)
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
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true })
    } catch {
      // fall through; the state write reports real trouble
    }
    writeIndicatorState(false)
    const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'PerseCuaIndicator.app')
    try {
      // Wait for the app itself to exit, including its idle timeout. An ordinary
      // `open` exits as soon as the launch is accepted and cannot track liveness.
      const launcher = execFile('open', ['-g', '-W', app, '--args', stateFile], () => {
        if (indicatorProcess !== launcher) return
        indicatorProcess = undefined
        indicatorLaunched = false // a later action can retry an exit or failure
      })
      indicatorProcess = launcher
    } catch {
      indicatorLaunched = false
    }
  }
  const noteIndicatorActivity = (rawName: string): void => {
    if (indicatorClosed || READ_ONLY_TOOLS.has(rawName)) return
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

  /**
   * Driving view: an in-app panel (contributed through the host's `panels`
   * service, DSH >= ui-panels) showing the driven window's thumbnail plus the
   * latest action caption — the Codex-style "what is the agent doing" surface,
   * but in-app, draggable, and per-window instead of full-screen. Optional by
   * design: hosts without the service keep working untouched.
   */
  interface PanelsService {
    upsert(id: string, patch: { title?: string; caption?: string; image?: string; meta?: Record<string, string> }): void
    remove(id: string): void
  }
  const drivingPanelEnabled = config.drivingPanel ?? bestExperience
  const panelsService: PanelsService | undefined = (() => {
    if (!drivingPanelEnabled) return undefined
    try {
      const got: unknown = ctx.get('panels')
      if (got !== null && typeof got === 'object' && 'upsert' in got && 'remove' in got) return got as PanelsService
    } catch {
      // host without a panels service: no driving view, everything else works
    }
    return undefined
  })()
  const PANEL_ID = 'perse-cua/driving'
  let panelShotAt = 0
  let panelIdleTimer: ReturnType<typeof setTimeout> | undefined
  const updateDrivingPanel = async (rawName: string, callArgs: Record<string, unknown>): Promise<void> => {
    const panels = panelsService
    if (panels === undefined) return
    if (panelIdleTimer !== undefined) clearTimeout(panelIdleTimer)
    panelIdleTimer = setTimeout(() => {
      panelIdleTimer = undefined
      panels.remove(PANEL_ID)
    }, 8000)
    const pid = typeof callArgs.pid === 'number' ? callArgs.pid : undefined
    const windowId = typeof callArgs.window_id === 'number' ? callArgs.window_id : undefined
    const target = pid === undefined ? rawName : windowId === undefined ? `${rawName} (pid ${String(pid)})` : `${rawName} (pid ${String(pid)}, window ${String(windowId)})`
    const now = Date.now()
    if (pid === undefined || windowId === undefined || now - panelShotAt < 1000) {
      panels.upsert(PANEL_ID, { title: 'Computer use', caption: target })
      return
    }
    panelShotAt = now
    try {
      const shot = await client.callTool('get_window_state', { pid, window_id: windowId, include_screenshot: true, max_dimension: 320 })
      const image = shot.content.find(block => block.type === 'image')
      panels.upsert(PANEL_ID, {
        title: 'Computer use',
        caption: target,
        ...(image?.data === undefined ? {} : { image: `data:${image.mimeType ?? 'image/png'};base64,${image.data}` }),
      })
    } catch {
      panels.upsert(PANEL_ID, { title: 'Computer use', caption: target })
    }
  }
  const closeDrivingPanel = (): void => {
    if (panelIdleTimer !== undefined) {
      clearTimeout(panelIdleTimer)
      panelIdleTimer = undefined
    }
    panelsService?.remove(PANEL_ID)
  }

  const boot = async (): Promise<void> => {
    await client.start()
    const advertised = await client.listTools()
    const policy = resolvePolicy()
    const curation = curateTools(advertised.map(tool => tool.name), policy.allow, policy.deny)
    const byName = new Map(advertised.map(tool => [tool.name, tool]))

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
        (name: string, args: Record<string, unknown>) => { void updateDrivingPanel(name, args) }))
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

    if (bestExperience) await enableBestExperienceCursor()
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
  onExecuted?: (rawName: string, callArgs: Record<string, unknown>) => void,
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
    async execute(args: unknown): Promise<{ blocks: RenderBlock[] }> {
      onCall?.(rawName)
      let callArgs: Record<string, unknown> = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
      // Best experience: unlabeled calls would act through the implicit lease, whose
      // cursor nobody enabled. Route them through the cursor session so the overlay
      // animates — Codex-style — while still letting the model override `session`.
      if (cursorFor !== undefined && callArgs.session === undefined && acceptsSession(tool) && !SESSION_LIFECYCLE.has(rawName)) {
        callArgs = { session: cursorFor(), ...callArgs }
      }
      const result = await client.callTool(rawName, callArgs)
      if (!READ_ONLY_TOOLS.has(rawName)) onExecuted?.(rawName, callArgs)
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
