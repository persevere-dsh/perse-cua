/** Keep the installable archive's documentation and license identical to repository sources. */
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const destination = new URL('../packages/perse-cua/', import.meta.url)
for (const name of ['README.md', 'README.zh.md', 'LICENSE']) {
  copyFileSync(fileURLToPath(new URL(name, root)), fileURLToPath(new URL(name, destination)))
}
