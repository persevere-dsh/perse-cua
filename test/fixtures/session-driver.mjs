import { createInterface } from 'node:readline'
import { appendFileSync, existsSync } from 'node:fs'
const [log, expired] = process.argv.slice(2)
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'session-fixture', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: ['get_window_state', 'end_session', 'browser_navigate'].map(name => ({ name, inputSchema: { type: 'object', properties: { session: { type: 'string' } } } })) }
  else {
    const { name, arguments: args } = request.params
    appendFileSync(log, JSON.stringify({ pid: process.pid, name, args }) + '\n')
    if (name === 'start_session') result = { content: [{ type: 'text', text: "✅ Session 'implicit' is active." }], structuredContent: { session: args.session ?? 'implicit', active: true } }
    else if (name === 'get_window_state' && (args.session === 'user-ended' || (args.session !== undefined && existsSync(expired)))) result = { isError: true, content: [{ type: 'text', text: `session has ended; tool call 'get_window_state' was rejected. Call start_session with session '${args.session}' to start it again, or use a new session label.` }], structuredContent: { code: 'tool_invocation_failed', exit_code: 1 } }
    else result = { content: [{ type: 'text', text: 'ok' }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
