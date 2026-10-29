import type { Context } from '@deepseek-ai/cordis'
import { PreviewService } from './view.js'
export { PreviewService } from './view.js'

/** Register only the window preview service without starting a driver. */
export const apply = (ctx: Context): (() => void) => {
  const view = new PreviewService(ctx)
  return () => view.close()
}
