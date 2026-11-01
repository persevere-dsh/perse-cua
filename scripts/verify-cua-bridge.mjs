import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'packages/perse-cua/vendor')
const metadata = JSON.parse(await readFile(join(vendor, 'dsh-cua-bridge.provenance.json'), 'utf8'))
const actual = createHash('sha256').update(await readFile(join(vendor, 'dsh-cua-bridge.js'))).digest('hex')
const artifact = createHash('sha256').update(await readFile(join(vendor, 'dsh-cua-screenshot-artifact.js'))).digest('hex')
if (typeof metadata.coreBaseCommit !== 'string' || typeof metadata.inputs !== 'object'
  || metadata.bridgeSha256 !== actual || metadata.screenshotArtifactSha256 !== artifact) {
  throw new Error('CUA bridge provenance does not match the bundled bridge; resynchronize it from the paired Core checkout')
}
