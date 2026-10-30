import { argumentsFor, buildHelper } from './native-helper.mjs'

try {
  console.log(JSON.stringify(await buildHelper(argumentsFor(process.argv.slice(2), 'build')), null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
