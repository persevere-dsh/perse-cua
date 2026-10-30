/** Optional native provider entry for DSH 0.2.1-rc.2. */
import { accessSync, constants } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as provider from '@deepseek-ai/dsh-experimental-cua-macos'
import { apply as applyPatched, type Hooks } from 'perse-cua/internal-provider'

export const name = 'perse-cua-native'
export const inject = provider.inject
export const Config = provider.Config
export type Config = provider.Config

/** Check the helper before scheduling provider activation. */
export function resolveHelper(config: Config): string {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || Number(release().split('.')[0]) < 23) {
    throw new Error('perse-cua native requires macOS 14 or later on Apple silicon or Intel')
  }
  const helperPath = config.helperPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'bin', `darwin-${process.arch}`, 'dsh-cua-native')
  try { accessSync(helperPath, constants.X_OK) } catch (error) {
    throw new Error(`perse-cua native helper is unavailable or not executable: ${helperPath}`, { cause: error })
  }
  return helperPath
}

/** Mount the original provider in this loader entry, preserving its consent namespace. */
export async function apply(ctx: Context, config: Config, hooks: Hooks = { onClient() {}, onRevoke() {} }): Promise<void> {
  const helperPath = resolveHelper(config)
  await applyPatched(ctx, { ...config, helperPath }, hooks)
}
