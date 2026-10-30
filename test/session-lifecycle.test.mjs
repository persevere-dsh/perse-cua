import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
const entry = process.env.PERSE_TEST_ENTRY ?? fileURLToPath(new URL('../packages/perse-cua/lib/index.js', import.meta.url))
const { apply } = await import(pathToFileURL(entry))
const fixture = fileURLToPath(new URL('./fixtures/session-driver.mjs', import.meta.url))
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await pause(10) } throw new Error('driver did not reach expected state') }

test('implicit transport survives idle, plugin reload and another instance without reviving explicit sessions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'perse-session-'))
  const log = join(dir, 'calls'); const expired = join(dir, 'expired'); writeFileSync(log, '')
  const records = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const owners = []
  const make = () => {
    const ctx = new Context(); const tools = new Map()
    ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
    const dispose = apply(ctx, { backend: 'mcp', command: process.execPath, args: [fixture, log, expired], indicator: false, drivingPanel: false })
    owners.push(dispose)
    return tools
  }
  t.after(() => { for (const dispose of owners) dispose(); rmSync(dir, { recursive: true, force: true }) })
  let first = make(); const other = make()
  await until(() => first.has('mcp__cua__get_window_state') && other.has('mcp__cua__get_window_state') && records().filter(row => row.name === 'set_agent_cursor_enabled').length === 2)
  const agent = { id: 'same-agent' }
  const get = tools => tools.get('mcp__cua__get_window_state').execute({ pid: 42, window_id: 7 }, { agent })
  await get(first)
  writeFileSync(expired, '')
  await get(first)
  owners[0]()
  first = make()
  await until(() => first.has('mcp__cua__get_window_state') && records().filter(row => row.name === 'set_agent_cursor_enabled').length === 3)
  await get(first)
  await get(other)
  const before = records().filter(row => row.name === 'start_session').length
  await assert.rejects(first.get('mcp__cua__get_window_state').execute({ pid: 42, window_id: 7, session: 'user-ended' }, { agent }), /session has ended/)
  assert.equal(records().filter(row => row.name === 'start_session').length, before, 'explicitly ended session is not revived')
  const gets = records().filter(row => row.name === 'get_window_state')
  assert.ok(gets.filter(row => row.args.session === undefined).length >= 4, 'default calls use their own transport session')
  assert.equal(gets.at(-1).args.session, 'user-ended')
  assert.ok(new Set(gets.filter(row => row.args.session === undefined).map(row => row.pid)).size >= 3, 'reload and parallel plugin use distinct transports')
})
