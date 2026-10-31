/** Native backend activation inside the owning loader entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import * as provider from './native.ts'
import type { Hooks } from 'perse-cua/internal-provider'

/** Preserve native volatile grants at the root of the owning loader configuration. */
export const NativeConfigFields = provider.Config.dict
if (NativeConfigFields === undefined) throw new Error('perse-cua native provider has an incompatible configuration schema')
/** Resolve native defaults for callers that do not use the Loader. */
export const resolveNativeConfig = provider.Config
export { Schema }

/** Mount the provider under the same Loader entry; no competing transport starts. */
export function startNative(ctx: Context, config: provider.Config, hooks: Hooks): void {
  provider.resolveHelper(config)
  if (ctx.get('computerUse')?.providerName !== undefined) throw new Error(`perse-cua cannot start: computer-use provider "${ctx.computerUse.providerName}" is already registered`)
  if (ctx.get('computerUse') === undefined) ctx.plugin(ComputerUseRegistry)
  else ctx.on('internal/service', (name, value) => {
    if (name === 'computerUse' && value === undefined) console.error('[perse-cua] The host computer-use registry was removed; native control is unavailable until it returns.')
  })
  ctx.inject(provider.inject, async scope => {
    try {
      await provider.apply(scope, config, { ...hooks, onVolatile: listener => { scope.effect(() => ctx.on('loader/volatile-update', listener)) } })
      scope.effect(() => scope.systemPrompt.section({
        name: 'perse-cua:native-entry',
        order: scope.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
        text: 'For macOS desktop interaction, prefer the registered cua tool and its application authorization flow. Do not load the external cua-driver skill for native cua. If it is already loaded, do not apply its CLI or MCP parameters to cua; follow the cua tool schema and native guidance. If a required capability such as typed browser tabs is unavailable, explain the limitation and use an explicitly configured compatible provider if available. Do not switch providers to bypass denied or revoked access.',
      }))
    }
    catch (error) { console.error('[perse-cua] Native provider failed to start:', error); throw error }
  })
}
