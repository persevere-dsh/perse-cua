import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const fixture = fileURLToPath(import.meta.url)
const record = (root, event) => appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify({ ...event, pid: process.pid })}\n`)
const settings = root => JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'))

// Stand in for LaunchServices, not for the plugin's lifecycle controller. The
// real subprocesses let tests observe launcher/helper exit independently.
export async function launch(root) {
  const args = process.argv.slice(2)
  const stateFile = args[args.indexOf('--args') + 1]
  record(root, { type: 'launcher', args })
  const config = settings(root)
  const attempts = readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(line => line && JSON.parse(line).type === 'launcher').length
  if (attempts <= (config.failedLaunches ?? 0)) {
    record(root, { type: 'launch-failed' })
    process.exitCode = 3
    return
  }
  await pause(config.launchDelayMs ?? 0)
  const child = spawn(process.execPath, [fixture, 'helper', root, stateFile], { stdio: 'ignore' })
  record(root, { type: 'helper-spawned', childPid: child.pid })
  if (args.includes('-W')) await new Promise(resolve => child.once('close', resolve))
  else child.unref()
  record(root, { type: 'launcher-exit' })
}

if (process.argv[2] === 'helper') {
  const [, , , root, stateFile] = process.argv
  record(root, { type: 'helper-ready' })
  // Exercise the existing helper contract: exit when its owner removes the
  // state or when a written timestamp has expired. No AppKit is loaded.
  while (existsSync(stateFile)) {
    try {
      if (Date.now() / 1000 - JSON.parse(readFileSync(stateFile, 'utf8')).ts > 60) break
    } catch { /* A partial state write is retried on the next poll. */ }
    await pause(10)
  }
  record(root, { type: 'helper-exit' })
} else if (process.argv[2] === 'mcp') {
  const root = process.argv[3]
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
    else if (request.method === 'tools/list') result = { tools: ['click', 'list_apps'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) }
    else {
      record(root, { type: 'tool-call', name: request.params.name })
      if (request.params.name === 'start_session') await pause(settings(root).sessionDelayMs ?? 0)
      result = { content: [{ type: 'text', text: request.params.name === 'start_session' ? '{"session":"fixture"}' : 'fixture tool result' }] }
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
  }
}
