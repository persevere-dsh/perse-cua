import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CuaConfig } from '@deepseek-ai/dsh-cua'
export type Config = CuaConfig
export const Config: typeof CuaConfig
export const inject: string[]
export type Capture = (appHandle: string, windowId: number, signal: AbortSignal) => Promise<{ data: string; mimeType: string; windowId: number; bounds?: { x: number; y: number; width: number; height: number } }>
export type ListWindows = (appHandle: string, signal: AbortSignal) => Promise<Array<{ windowId: number; title: string; bounds: { x: number; y: number; width: number; height: number }; isOnScreen: boolean; onCurrentSpace: boolean | null }>>
export interface VisualEvent { type: 'visual'; requestId: string; appHandle: string; windowId: number; process: { pid: number; startedSeconds: number; startedMicroseconds: number }; geometry: { x: number; y: number; width: number; height: number }; sequence: number; color: string; trajectory: { samples: Array<{ t: number; x: number; y: number; angle: number }>; arrivalT: number }; elapsedMs: number; phase: 'move' | 'click' | 'position' | 'clear' }
export interface Hooks { onVisual?(agent: Agent, event: VisualEvent): void; onClient?(agent: Agent, capture: Capture, list: ListWindows): void; onConnectionReady?(agent: Agent): void; onConnectionFailure?(agent: Agent, code: string): void; }
export function apply(ctx: Context, config: Config, hooks: Hooks): Promise<void>
