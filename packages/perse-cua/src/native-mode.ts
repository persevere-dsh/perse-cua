/** Native backend activation inside the owning loader entry. */
import type { Context } from '@deepseek-ai/cordis'
import { release } from 'node:os'
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
  const admission = (ctx.get.bind(ctx) as (name: string) => unknown)('profileToolAdmission')
  const reportStartupFailure = (reason?: string): void => {
    if (admission !== null && typeof admission === 'object' && 'reportStartupFailure' in admission && typeof admission.reportStartupFailure === 'function') {
      admission.reportStartupFailure('cua', reason)
    }
  }
  try { provider.resolveHelper(config) }
  catch (error) {
    const supported = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) && Number(release().split('.')[0]) >= 23
    reportStartupFailure(supported ? 'NATIVE_HELPER_UNAVAILABLE' : 'NATIVE_PLATFORM_UNSUPPORTED')
    throw error
  }
  if (ctx.get('computerUse')?.providerName !== undefined) throw new Error(`perse-cua cannot start: computer-use provider "${ctx.computerUse.providerName}" is already registered`)
  if (ctx.get('computerUse') === undefined) ctx.plugin(ComputerUseRegistry)
  else ctx.on('internal/service', (name, value) => {
    if (name === 'computerUse' && value === undefined) console.error('[perse-cua] The host computer-use registry was removed; native control is unavailable until it returns.')
  })
  ctx.inject(provider.inject, async scope => {
    try {
      await provider.apply(scope, config, { ...hooks, onVolatile: listener => { scope.effect(() => ctx.on('loader/volatile-update', listener)) } })
      reportStartupFailure()
      scope.effect(() => scope.systemPrompt.section({
        name: 'perse-cua:native-entry',
        order: scope.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
        text: 'For macOS desktop interaction, use the registered cua tool and its application authorization flow. Do not use external cua-driver CLI or MCP tools. If a required capability is unavailable, explain the limitation. Do not switch providers to bypass denied or revoked access.',
      }))
    }
    catch (error) { reportStartupFailure('NATIVE_START_FAILED'); console.error('[perse-cua] Native provider failed to start:', error); throw error }
  })
}
