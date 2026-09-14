/**
 * Which cua-driver tools this plugin puts in front of the model.
 *
 * cua-driver advertises 56 tools. Every one of them is a tool definition in each
 * model request whether or not the task touches it, and on 0.28.1 they measured
 * 93 KB of model-facing schema (name + description + inputSchema) per request.
 * The default here keeps the desktop-automation loop and drops the surfaces a
 * coding session does not need: browser CDP tooling, trajectory recording,
 * cursor cosmetics, session lifecycle, and the self-update probe.
 *
 * `allow` is a starting point, not a ceiling: a caller widens it from config, and
 * `deny` always wins. Names are matched with or without the `mcp__<server>__`
 * namespace so the same list works for a renamed server row.
 *
 * @module perse-cua/curate
 */

/**
 * Tools kept by default: discover a target, observe it, act on it, verify it,
 * plus the few read-only probes needed to diagnose a stuck loop.
 */
export const DEFAULT_ALLOW: readonly string[] = [
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

/** Names dropped even when an `allow` entry would otherwise keep them. */
export const DEFAULT_DENY: readonly string[] = []

/** One tool's admission decision. */
export interface ToolDecision {
  readonly name: string
  readonly keep: boolean
  readonly reason: 'allowed' | 'not-in-allow' | 'denied'
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
 * @param allow - names to keep, bare or namespaced.
 * @param deny - names to drop; takes precedence over `allow`.
 * @param serverName - optional server row name, used to match namespaced entries.
 * @returns per-tool decisions plus the resulting keep/drop sets.
 */
export function curateTools(
  advertised: readonly string[],
  allow: readonly string[] = DEFAULT_ALLOW,
  deny: readonly string[] = DEFAULT_DENY,
  serverName?: string,
): CurationResult {
  const allowSet = new Set(allow.map(name => bareToolName(name, serverName)))
  const denySet = new Set(deny.map(name => bareToolName(name, serverName)))
  const decisions: ToolDecision[] = []
  const matched = new Set<string>()

  for (const name of advertised) {
    const bare = bareToolName(name, serverName)
    let reason: ToolDecision['reason'] = 'not-in-allow'
    if (denySet.has(bare)) reason = 'denied'
    else if (allowSet.has(bare)) reason = 'allowed'
    if (reason !== 'not-in-allow') matched.add(bare)
    decisions.push({ name, keep: reason === 'allowed', reason })
  }

  const unmatched = [...allowSet].filter(name => !matched.has(name) && !denySet.has(name))
  return {
    decisions,
    keep: decisions.filter(decision => decision.keep).map(decision => decision.name),
    drop: decisions.filter(decision => !decision.keep).map(decision => decision.name),
    unmatched,
  }
}
