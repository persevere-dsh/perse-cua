import { build } from 'tsdown'
await build({
  config: false,
  entry: { presenter: 'packages/perse-cua/lib/types/presenter.js' },
  outDir: 'packages/perse-cua/lib', format: 'esm', platform: 'node', target: 'node22',
  clean: false, fixedExtension: false, dts: false,
  deps: { neverBundle: ['@deepseek-ai/cordis'] },
})
