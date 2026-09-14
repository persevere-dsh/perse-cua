/**
 * Host-side tests for the accessibility-tree trimmer.
 *
 * The fixture mirrors a real macOS Calculator snapshot: one window block, one
 * menu-bar block, and a multi-line element header whose continuation lines have
 * no leading dash. The assertions pin the properties that matter — the window
 * survives, the menu does not, and surviving text stays byte-identical — because
 * a rewrite that renumbered or reflowed elements would silently retarget every
 * later action against the driver's cached snapshot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { condenseDescription, trimAxMenuTree } from '../packages/perse-cua/lib/types/trim.js'

const SNAPSHOT = [
  'window_id=33614 pid=90736 elements=8',
  '',
  '- [0] AXWindow "计算器" [id=main actions=[raise]]',
  '    - AXStaticText = "9+9"',
  '    - AXStaticText = "18"',
  '    - [1] AXButton (7) [id=Seven actions=[press]]',
  '    - [2] AXButton (模式) [id=Mode: basic actions=[press,showmenu,name:移到上一项',
  'target:0x0',
  'selector:(null)]]',
  '- [3] AXMenuBar [actions=[cancel]]',
  '  - [4] AXMenuBarItem "Apple" [actions=[press]]',
  '    - [5] AXMenu [actions=[cancel]]',
  '      - [6] AXMenuItem "关于本机" [id=_aboutThisMacRequested: actions=[press]]',
  '  - [7] AXMenuBarItem "帮助" [actions=[press]]',
].join('\n')

test('drops the menu subtree and keeps the window block', () => {
  const { text, droppedBlocks } = trimAxMenuTree(SNAPSHOT)
  assert.equal(droppedBlocks, 1)
  assert.ok(text.includes('AXWindow "计算器"'))
  assert.ok(text.includes('AXButton (7)'))
  assert.ok(!text.includes('AXMenuBar'))
  assert.ok(!text.includes('AXMenuItem'))
  assert.ok(!text.includes('关于本机'))
})

test('keeps the window block byte-identical, including multi-line headers', () => {
  const { text } = trimAxMenuTree(SNAPSHOT)
  const windowBlock = SNAPSHOT.split('\n').slice(0, 9).join('\n')
  assert.ok(text.startsWith(windowBlock), 'window block must survive verbatim')
})

test('never renumbers surviving elements', () => {
  const { text } = trimAxMenuTree(SNAPSHOT)
  // The window header count and every index stay exactly as the driver wrote them.
  assert.ok(text.includes('elements=8'))
  assert.ok(text.includes('[0] AXWindow'))
  assert.ok(text.includes('[1] AXButton'))
  assert.ok(text.includes('[2] AXButton'))
})

test('passes through text that is not a tree', () => {
  const prose = 'Launched 计算器 (pid 90736) in background.\n\nWindows:\n- "计算器" [window_id: 33614]'
  const { text, droppedBlocks, droppedLines } = trimAxMenuTree(prose)
  assert.equal(text, prose)
  assert.equal(droppedBlocks, 0)
  assert.equal(droppedLines, 0)
})

test('drops a menu block that is not at depth zero without touching its siblings', () => {
  const nested = [
    '- [0] AXWindow "App"',
    '  - [1] AXGroup',
    '    - [2] AXMenu "context"',
    '      - [3] AXMenuItem "Duplicate"',
    '  - [4] AXButton (Keep me)',
  ].join('\n')
  const { text } = trimAxMenuTree(nested)
  assert.ok(!text.includes('Duplicate'))
  assert.ok(text.includes('[4] AXButton (Keep me)'))
})

test('condenses a description to its first sentence and caps the length', () => {
  assert.equal(condenseDescription('Click a thing. Then do more.'), 'Click a thing.')
  assert.equal(condenseDescription('Click a thing'), 'Click a thing')
  assert.equal(condenseDescription('   '), '')
  const long = condenseDescription(`${'a'.repeat(500)}.`)
  assert.ok(long.length <= 200, `expected <=200 chars, got ${long.length}`)
  assert.ok(long.endsWith('…'))
})

test('condenses CJK sentence punctuation too', () => {
  assert.equal(condenseDescription('点击一个元素。后面的说明都不要。'), '点击一个元素。')
})
