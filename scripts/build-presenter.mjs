import { build } from 'tsdown'
await build({
  config: false,
  entry: { presenter: 'packages/perse-cua/lib/types/presenter.js', native: 'packages/perse-cua/lib/types/native.js' },
  outDir: 'packages/perse-cua/lib', format: 'esm', platform: 'node', target: 'node22',
  clean: false, fixedExtension: false, dts: false,
  deps: { neverBundle: ['perse-cua/internal-provider', '@deepseek-ai/cordis', '@deepseek-ai/dsh-experimental-cua-macos'] },
})
