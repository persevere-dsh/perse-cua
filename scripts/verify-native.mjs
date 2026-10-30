import { join } from 'node:path'
import { verifyHelper, verifyPortable } from './native-helper.mjs'

try {
  const root = join(process.cwd(), 'packages/perse-cua/native/bin')
  for (const arch of ['arm64', 'x64']) {
    const directory = join(root, `darwin-${arch}`)
    const spec = { binary: join(directory, 'dsh-cua-native'), manifest: join(directory, 'manifest.json'), arch }
    if (process.platform === 'darwin') await verifyHelper(spec)
    else await verifyPortable(spec)
  }
  if (process.platform !== 'darwin') console.warn('Native signatures and Mach-O architectures require verification on macOS before release.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
