/**
 * Host-side tests for the tool-surface curation policy.
 *
 * These run without the DSH harness and without cua-driver: the policy is pure,
 * so the assertions describe exactly which advertised names reach the model.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { bareToolName, curateTools, DEFAULT_DENY, MINIMAL_ALLOW, WASTE_ONLY_TOOLS } from '../packages/perse-cua/lib/types/curate.js'

const ADVERTISED = [
  'mcp__cua__list_apps',
  'mcp__cua__get_window_state',
  'mcp__cua__click',
  'mcp__cua__page',
  'mcp__cua__start_recording',
  'mcp__cua__set_agent_cursor_theme',
  'mcp__cua__browser_navigate',
]

test('default policy keeps every capability and only denies proven waste', () => {
  const result = curateTools(ADVERTISED, undefined, DEFAULT_DENY, 'cua')
  assert.deepEqual(result.drop, ['mcp__cua__set_agent_cursor_theme'])
  assert.deepEqual(result.keep, [
    'mcp__cua__list_apps',
    'mcp__cua__get_window_state',
    'mcp__cua__click',
    'mcp__cua__page',
    'mcp__cua__start_recording',
    'mcp__cua__browser_navigate',
  ])
})

test('MINIMAL_ALLOW still reproduces the earlier desktop-only cut', () => {
  const result = curateTools(ADVERTISED, MINIMAL_ALLOW, [], 'cua')
  assert.deepEqual(result.keep, ['mcp__cua__list_apps', 'mcp__cua__get_window_state', 'mcp__cua__click'])
  assert.deepEqual(result.drop, ['mcp__cua__page', 'mcp__cua__start_recording', 'mcp__cua__set_agent_cursor_theme', 'mcp__cua__browser_navigate'])
})

test('deny wins over allow', () => {
  const result = curateTools(ADVERTISED, ['click', 'list_apps'], ['click'], 'cua')
  assert.deepEqual(result.keep, ['mcp__cua__list_apps'])
  const click = result.decisions.find(decision => decision.name === 'mcp__cua__click')
  assert.equal(click?.reason, 'denied')
})

test('accepts bare and namespaced policy entries interchangeably', () => {
  const bare = curateTools(ADVERTISED, ['click'], [], 'cua')
  const namespaced = curateTools(ADVERTISED, ['mcp__cua__click'], [], 'cua')
  assert.deepEqual(bare.keep, namespaced.keep)
  assert.deepEqual(bare.keep, ['mcp__cua__click'])
})

test('reports allow entries that matched nothing, without failing', () => {
  const result = curateTools(ADVERTISED, ['click', 'does_not_exist'], [], 'cua')
  assert.deepEqual(result.unmatched, ['does_not_exist'])
  assert.deepEqual(result.keep, ['mcp__cua__click'])
})

test('a policy entry that is also denied is not reported as unmatched', () => {
  const result = curateTools(ADVERTISED, ['does_not_exist'], ['does_not_exist'], 'cua')
  assert.deepEqual(result.unmatched, [])
})

test('an empty advertised surface yields empty keep and drop', () => {
  const result = curateTools([], MINIMAL_ALLOW, [], 'cua')
  assert.deepEqual(result.keep, [])
  assert.deepEqual(result.drop, [])
})

test('bareToolName strips the server prefix it was given, else any namespace', () => {
  assert.equal(bareToolName('mcp__cua__click', 'cua'), 'click')
  assert.equal(bareToolName('mcp__cua__click'), 'click')
  assert.equal(bareToolName('click'), 'click')
})

test('both policy lists are duplicate-free and name only bare tools', () => {
  for (const list of [MINIMAL_ALLOW, WASTE_ONLY_TOOLS]) {
    assert.equal(new Set(list).size, list.length)
    for (const name of list) assert.ok(!name.startsWith('mcp__'), `${name} must be bare`)
  }
})

test('the default deny list is exactly the waste list and excludes real capabilities', () => {
  assert.deepEqual([...DEFAULT_DENY], [...WASTE_ONLY_TOOLS])
  for (const name of ['move_cursor', 'get_cursor_position', 'browser_pointer', 'browser_click', 'replay_trajectory', 'start_session']) {
    assert.ok(!DEFAULT_DENY.includes(name), `${name} carries capability and must not be denied by default`)
  }
})
