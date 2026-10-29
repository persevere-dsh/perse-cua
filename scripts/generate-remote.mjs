import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'

const stage = resolve('.typert-build')
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
rmSync(stage, { recursive: true, force: true })
try {
  mkdirSync(`${stage}/packages/protocol/src`, { recursive: true })
  cpSync('node_modules/@deepseek-ai/dsh-typert-protocol/lib/types', `${stage}/packages/protocol/src`, { recursive: true })
  cpSync(`${stage}/packages/protocol/src/index.d.ts`, `${stage}/packages/protocol/src/index.ts`)
  const protocol = JSON.parse(readFileSync('node_modules/@deepseek-ai/dsh-typert-protocol/package.json', 'utf8'))
  protocol.exports = { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } }
  json(`${stage}/packages/protocol/package.json`, protocol)
  json(`${stage}/packages/protocol/tsconfig.json`, { extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types', noEmit: false }, include: ['src/**/*.ts'] })
  mkdirSync(`${stage}/packages/perse-cua`, { recursive: true })
  cpSync('packages/perse-cua/src', `${stage}/packages/perse-cua/src`, { recursive: true })
  const stagedEntry = `${stage}/packages/perse-cua/src/index.ts`
  const entry = readFileSync(stagedEntry, 'utf8').replace("import type { Agent } from '@deepseek-ai/dsh-agent'", 'type Agent = { readonly id: string }')
  writeFileSync(stagedEntry, entry)
  cpSync('packages/perse-cua/package.json', `${stage}/packages/perse-cua/package.json`)
  json(`${stage}/packages/perse-cua/tsconfig.json`, { extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types', noEmit: false }, include: ['src'], references: [{ path: '../protocol' }] })
  const base = JSON.parse(readFileSync('tsconfig.base.json', 'utf8'))
  base.compilerOptions.lib.push('DOM')
  base.compilerOptions.baseUrl = '.'
  base.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': ['./packages/protocol/src/index.ts'] }
  json(`${stage}/tsconfig.base.json`, base)
  json(`${stage}/tsconfig.host.json`, { extends: './tsconfig.base.json', files: [], references: [{ path: './packages/protocol' }, { path: './packages/perse-cua' }] })
  symlinkSync(resolve('node_modules'), `${stage}/node_modules`, 'dir')
  const artifacts = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false }).generate(['perse-cua'], ['host'])
  writePackageArtifacts(resolve('packages/perse-cua'), artifacts)
} finally { rmSync(stage, { recursive: true, force: true }) }
