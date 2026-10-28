/**
 * Which cua-driver tools this plugin puts in front of the model.
 *
 * Design rule, learned the hard way: **default to capability-complete and subtract
 * only proven waste.** An earlier revision curated against a hand-written list of
 * "the desktop-automation loop", which measured better but silently removed whole
 * capabilities — web automation, trajectory replay, session lifecycle, the real
 * pointer — so most of the schema saving it produced was capability removal rather
 * than waste removal. See README.md for the arithmetic.
 *
 * So the default here denies nothing but {@link WASTE_ONLY_TOOLS} and keeps every
 * advertised tool otherwise. {@link MINIMAL_ALLOW} remains available for a
 * token-tight profile that knowingly gives those capabilities up.
 *
 * Names are matched with or without the `mcp__<server>__` namespace so the same
 * policy works for a renamed server row.
 *
 * @module perse-cua/curate
 */

/**
 * The four `*_agent_cursor_*` tools. An earlier revision denied them as overlay
 * "artwork"; that judgment predates the Codex-style background-driving
 * experience, where the **visible agent cursor is the product**: the user sees
 * exactly where the agent is working while their own mouse and focus stay free.
 * They are a capability, not waste, and `bestExperience` (on by default) keeps
 * them and turns the cursor on at boot.
 */
export const CURSOR_EXPERIENCE_TOOLS: readonly string[] = [
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'get_agent_cursor_state',
]

/**
 * Tools that cannot change a task outcome, so denying them costs nothing:
 *
 * - `check_for_update` duplicates the `cua-driver check-update` CLI;
 * - `escalate_session` and `get_session_state` are deprecated compatibility
 *   shims (the driver's own descriptions say so).
 */
export const BASE_WASTE_TOOLS: readonly string[] = [
  'check_for_update',
  'escalate_session',
  'get_session_state',
]

/** All provable waste, including the cursor tools: the deny set when `bestExperience` is off. */
export const WASTE_ONLY_TOOLS: readonly string[] = [...BASE_WASTE_TOOLS, ...CURSOR_EXPERIENCE_TOOLS]

/**
 * Default deny list (`bestExperience` on). Kept tiny on purpose: everything in
 * it must be provably incapable of affecting a task.
 */
export const DEFAULT_DENY: readonly string[] = BASE_WASTE_TOOLS

/** Default allow list: absent, meaning "keep every tool the driver advertises". */
export const DEFAULT_ALLOW: readonly string[] | undefined = undefined

/**
 * The aggressive cut: desktop automation only, giving up web automation,
 * trajectory replay, session lifecycle, recording, and the real pointer.
 *
 * Prefer this only when request size matters more than reach, and prefer extending
 * it over trimming it — an allow list is a capability ceiling, and a tool missing
 * from it is invisible to the model rather than merely unused.
 *
 * Note: under `bestExperience` (the default) the agent-cursor tools are unioned
 * back in — see {@link minimalAllowWithCursor}; deny them explicitly to cut them
 * regardless.
 */
export const MINIMAL_ALLOW: readonly string[] = [
  // discover + launch
  'list_apps',
  'list_windows',
  'launch_app',
  'kill_app',
  // observe
  'get_window_state',
  'verify_state',
  'get_screen_size',
  'get_desktop_state',
  'get_accessibility_tree',
  'zoom',
  // act
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'invoke_menu',
  'set_window_frame',
  'bring_to_front',
  // transfer
  'clipboard_read',
  'clipboard_write',
  // diagnose
  'check_permissions',
  'health_report',
  'get_config',
]

/**
 * `MINIMAL_ALLOW` plus the four agent-cursor tools, so a token-tight profile can
 * still show the visible cursor under `bestExperience`. Applied by the plugin when
 * `allow` is exactly `MINIMAL_ALLOW`; an explicit custom allow list is respected
 * verbatim.
 */
export function minimalAllowWithCursor(): readonly string[] {
  return [...MINIMAL_ALLOW, ...CURSOR_EXPERIENCE_TOOLS]
}

/** One tool's admission decision. */
export interface ToolDecision {
  readonly name: string
  readonly keep: boolean
  readonly reason: 'allowed' | 'not-in-allow' | 'denied' | 'kept-by-default'
}

/** Outcome of applying an allow/deny policy to an advertised tool list. */
export interface CurationResult {
  readonly decisions: readonly ToolDecision[]
  readonly keep: readonly string[]
  readonly drop: readonly string[]
  /** `allow` entries that matched no advertised tool — usually a typo or a version drift. */
  readonly unmatched: readonly string[]
}

/** Strip the `mcp__<server>__` prefix so policy names stay transport-agnostic. */
export function bareToolName(name: string, serverName?: string): string {
  if (serverName !== undefined) {
    const prefix = `mcp__${serverName}__`
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  const namespaced = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name)
  return namespaced?.[1] ?? name
}

/**
 * Apply one allow/deny policy to the names a server actually advertised.
 *
 * @param advertised - tool names exactly as the harness sees them.
 * @param allow - names to keep, bare or namespaced; `undefined` keeps everything
 *   except what `deny` removes.
 * @param deny - names to drop; takes precedence over `allow`.
 * @param serverName - optional server row name, used to match namespaced entries.
 * @returns per-tool decisions plus the resulting keep/drop sets.
 */
export function curateTools(
  advertised: readonly string[],
  allow: readonly string[] | undefined = DEFAULT_ALLOW,
  deny: readonly string[] = DEFAULT_DENY,
  serverName?: string,
): CurationResult {
  const allowSet = allow === undefined ? undefined : new Set(allow.map(name => bareToolName(name, serverName)))
  const denySet = new Set(deny.map(name => bareToolName(name, serverName)))
  const decisions: ToolDecision[] = []
  const matched = new Set<string>()

  for (const name of advertised) {
    const bare = bareToolName(name, serverName)
    let reason: ToolDecision['reason']
    if (denySet.has(bare)) reason = 'denied'
    else if (allowSet === undefined) reason = 'kept-by-default'
    else if (allowSet.has(bare)) reason = 'allowed'
    else reason = 'not-in-allow'
    if (reason === 'denied' || reason === 'allowed') matched.add(bare)
    decisions.push({ name, keep: reason !== 'denied' && reason !== 'not-in-allow', reason })
  }

  const unmatched = allowSet === undefined
    ? []
    : [...allowSet].filter(name => !matched.has(name) && !denySet.has(name))
  return {
    decisions,
    keep: decisions.filter(decision => decision.keep).map(decision => decision.name),
    drop: decisions.filter(decision => !decision.keep).map(decision => decision.name),
    unmatched,
  }
}
