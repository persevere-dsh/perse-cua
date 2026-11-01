import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const core = process.argv[2] && resolve(process.argv[2])
if (!core) throw new Error('Usage: node scripts/sync-cua-bridge.mjs <core-checkout>')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'packages/perse-cua/vendor/dsh-cua-bridge.js')
const source = 'packages/experimental/cua/src/'
const files = ['bridge.ts', 'api.ts', 'protocol.ts', 'types.ts', 'screenshot-artifact.ts', 'native-client.ts']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [source + file, digest(await readFile(join(core, source, file)))])))
const commit = execFileSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const builder = join(core, 'node_modules/.bin/esbuild')
execFileSync(builder, [join(core, source, 'bridge.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${output}`], { stdio: 'inherit' })
const artifact = join(root, 'packages/perse-cua/vendor/dsh-cua-screenshot-artifact.js')
execFileSync(builder, [join(core, source, 'screenshot-artifact.ts'), '--platform=node', '--format=esm', `--outfile=${artifact}`], { stdio: 'inherit' })
const compiled = await readFile(artifact, 'utf8')
if (!compiled.includes('"./native-client.ts"')) throw new Error('The Core screenshot artifact import changed; review the adapter before synchronizing')
await writeFile(artifact, compiled.replace('"./native-client.ts"', '"./dsh-cua.js"'))
const metadata = { coreBaseCommit: commit, inputs, bridgeSha256: digest(await readFile(output)), screenshotArtifactSha256: digest(await readFile(artifact)) }
await writeFile(join(root, 'packages/perse-cua/vendor/dsh-cua-bridge.provenance.json'), JSON.stringify(metadata, null, 2) + '\n')
