import { build } from 'tsdown'
await build({
  config: false,
  entry: { client: 'packages/perse-cua/client/index.jsx' },
  outDir: 'packages/perse-cua/lib', format: 'cjs', platform: 'browser', clean: false,
  fixedExtension: false, dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: ['react'] },
  outputOptions: {
    inlineDynamicImports: true,
    banner: 'window.__ModuleLoader__.load({ id: "perse-cua", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
