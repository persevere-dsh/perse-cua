import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from '@deepseek-ai/dsh-experimental-cua-macos'
export { Config, inject } from '@deepseek-ai/dsh-experimental-cua-macos'
export type Capture = (appHandle: string, windowId: number, signal: AbortSignal) => Promise<{ data: string; mimeType: string; windowId: number; bounds?: { width: number; height: number } }>
export type ListWindows = (appHandle: string, signal: AbortSignal) => Promise<Array<{ windowId: number; title: string; bounds: { width: number; height: number }; isOnScreen: boolean; onCurrentSpace: boolean | null }>>
export interface Hooks { onClient(agent: Agent, capture: Capture, list: ListWindows): void; onRevoke(agent: Agent, handle: string): void; onVolatile?(listener: () => void): void }
export function apply(ctx: Context, config: Config, hooks: Hooks): Promise<void>
