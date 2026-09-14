/**
 * Accessibility-tree hygiene for cua-driver results.
 *
 * A cua-driver window snapshot is a plain-text tree whose header names the
 * window and whose body is one indented `- [index] ROLE ...` block per element.
 * On macOS the tree carries the whole application menu bar as a sibling of the
 * window: measured on Calculator (a 230x408 window) the menu subtree was 145 of
 * 146 elements and 84% of the rendered lines, and it can never be the target of
 * an app-automation step — its items are reached through `invoke_menu` by path.
 *
 * This module removes that subtree and nothing else. It never renumbers the
 * surviving elements: an `element_token`/`element_index` in the remaining text
 * must keep resolving against the snapshot the driver cached, so a rewrite that
 * renumbered would silently retarget every later action.
 *
 * @module perse-cua/trim
 */

/** Element roles that make up a menu bar and can be dropped as one subtree. */
const MENU_ROLES = ['AXMenuBar', 'AXMenuBarItem', 'AXMenu', 'AXMenuItem'] as const

/** A tree body line that opens an element block, e.g. `  - [12] AXButton ...`. */
const BLOCK_HEADER = /^(\s*)- (?:\[(\d+)\] )?(.*)$/

/** How many leading spaces a line carries. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** True when a block opener declares one of the droppable menu roles. */
function isMenuHeader(line: string): boolean {
  const match = BLOCK_HEADER.exec(line)
  if (match === null) return false
  const body = match[3] ?? ''
  return MENU_ROLES.some(role => body === role || body.startsWith(`${role} `) || body.startsWith(`${role}[`))
}

/** Result of trimming one rendered tree. */
export interface TrimResult {
  /** The tree with every menu subtree removed; otherwise byte-identical input. */
  readonly text: string
  /** Body lines removed, including blank separators inside a dropped subtree. */
  readonly droppedLines: number
  /** Depth-0 menu blocks that were removed (macOS normally has exactly one). */
  readonly droppedBlocks: number
}

/**
 * Drop every accessibility menu subtree from one rendered tree.
 *
 * A menu block owns every following line indented deeper than its own opener, so
 * the scan skips forward while that holds and resumes at the next opener that is
 * at or above the menu's depth. Text that is not a tree (for example a tool's
 * prose result) passes through unchanged.
 *
 * @param text - rendered cua-driver output, typically `tree_markdown`.
 * @returns the trimmed text plus what was removed, for host-side accounting.
 */
export function trimAxMenuTree(text: string): TrimResult {
  const lines = text.split('\n')
  const kept: string[] = []
  let skipDepth: number | null = null
  let droppedLines = 0
  let droppedBlocks = 0

  for (const line of lines) {
    const opensBlock = BLOCK_HEADER.test(line)
    if (skipDepth !== null) {
      const depth = indentOf(line)
      // A blank line carries no depth; keep skipping only if the block continues.
      if (line.trim() === '') {
        droppedLines += 1
        continue
      }
      if (opensBlock && depth <= skipDepth) skipDepth = null
      else {
        droppedLines += 1
        continue
      }
    }
    if (opensBlock && isMenuHeader(line)) {
      skipDepth = indentOf(line)
      droppedBlocks += 1
      droppedLines += 1
      continue
    }
    kept.push(line)
  }

  return { text: kept.join('\n'), droppedLines, droppedBlocks }
}

/** Compress a description to its first sentence, capped for the tool schema. */
export function condenseDescription(description: string, maxChars = 200): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  if (flat === '') return flat
  const sentence = firstSentence(flat)
  if (sentence.length <= maxChars) return sentence
  return `${sentence.slice(0, maxChars - 1).trimEnd()}…`
}

/** CJK terminators end a sentence with no following space; ASCII ones need one. */
const CJK_TERMINATORS = '。！？'
const ASCII_TERMINATORS = '.!?'

/** The leading sentence of a flattened string, or the whole string when it has none. */
function firstSentence(flat: string): string {
  for (let index = 0; index < flat.length; index += 1) {
    const char = flat[index] as string
    if (CJK_TERMINATORS.includes(char)) return flat.slice(0, index + 1)
    if (!ASCII_TERMINATORS.includes(char)) continue
    const next = flat[index + 1]
    if (next === undefined || next === ' ') return flat.slice(0, index + 1)
  }
  return flat
}
