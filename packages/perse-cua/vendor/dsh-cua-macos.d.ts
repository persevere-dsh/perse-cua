import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CuaConfig } from '@deepseek-ai/dsh-cua'
export type Config = CuaConfig
export const Config: typeof CuaConfig
export const inject: string[]
export type Capture = (appHandle: string, windowId: number, signal: AbortSignal) => Promise<{ data: string; mimeType: string; windowId: number; bounds?: { width: number; height: number } }>
export type ListWindows = (appHandle: string, signal: AbortSignal) => Promise<Array<{ windowId: number; title: string; bounds: { width: number; height: number }; isOnScreen: boolean; onCurrentSpace: boolean | null }>>
export interface Hooks { onClient(agent: Agent, capture: Capture, list: ListWindows): void; onRevoke(agent: Agent, handle: string): void; onVolatile?(listener: () => void): void }
export function apply(ctx: Context, config: Config, hooks: Hooks): Promise<void>
