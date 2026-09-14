/**
 * Host-side tests for the tool-surface curation policy.
 *
 * These run without the DSH harness and without cua-driver: the policy is pure,
 * so the assertions describe exactly which advertised names reach the model.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { bareToolName, curateTools, DEFAULT_ALLOW } from '../packages/perse-cua/lib/types/curate.js'

const ADVERTISED = [
  'mcp__cua__list_apps',
  'mcp__cua__get_window_state',
  'mcp__cua__click',
  'mcp__cua__page',
  'mcp__cua__start_recording',
  'mcp__cua__set_agent_cursor_theme',
  'mcp__cua__browser_navigate',
]

test('keeps the automation loop and drops the rest of an advertised surface', () => {
  const result = curateTools(ADVERTISED, DEFAULT_ALLOW, [], 'cua')
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
  const result = curateTools([], DEFAULT_ALLOW, [], 'cua')
  assert.deepEqual(result.keep, [])
  assert.deepEqual(result.drop, [])
})

test('bareToolName strips the server prefix it was given, else any namespace', () => {
  assert.equal(bareToolName('mcp__cua__click', 'cua'), 'click')
  assert.equal(bareToolName('mcp__cua__click'), 'click')
  assert.equal(bareToolName('click'), 'click')
})

test('the default allow list has no duplicates and names only bare tools', () => {
  assert.equal(new Set(DEFAULT_ALLOW).size, DEFAULT_ALLOW.length)
  for (const name of DEFAULT_ALLOW) assert.ok(!name.startsWith('mcp__'), `${name} must be bare`)
})
