import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import * as Native from '../packages/perse-cua/lib/native.js'

test('native loader reserves one provider and releases its tool on disposal', { skip: process.platform !== 'darwin' }, async () => {
  const ctx = new Context()
  try {
    for (const plugin of [ComputerUse, Tools, Agents, Prompt, Subprocess]) await ctx.plugin(plugin)
    const fiber = await ctx.plugin(Native, {})
    await fiber.await()
    assert.equal(ctx.computerUse.providerName, 'dsh-cua')
    assert.ok(ctx.tools.get('cua'))
    assert.throws(() => ctx.computerUse.register('other'), /already registered/)
    await fiber.dispose()
    assert.equal(ctx.computerUse.providerName, undefined)
    assert.equal(ctx.tools.get('cua'), undefined)
  } finally { await ctx.fiber.dispose() }
})

test('native entry rejects an unavailable helper before provider registration', { skip: process.platform !== 'darwin' }, async () => {
  await assert.rejects(Native.apply({}, { helperPath: '/nonexistent/perse-cua-helper' }), /unavailable or not executable/)
})
