import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const log = process.argv[2]
const hidden = new Set()
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (!request.id) continue
  let result
  if (request.method === 'initialize') { appendFileSync(log, JSON.stringify({ pid: process.pid }) + '\n'); result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }
  else if (request.method === 'tools/list') result = { tools: ['get_window_state','move_cursor','click'].map(name => ({ name, inputSchema: { type: 'object', properties: { session: { type: 'string' } } } })) }
  else {
    const { name, arguments: args } = request.params
    appendFileSync(log, JSON.stringify({ name, args }) + '\n')
    if (args.delay) await new Promise(resolve => setTimeout(resolve, args.delay))
    if (args.offscreen) hidden.add(args.window_id)
    if (name === 'list_windows') result = { content: [{ type: 'text', text: 'Found 3 window(s).\n- Test (pid 12) "Window 7" [window_id: 7]' + (hidden.has(7) ? ' [off-screen]' : '') + '\n- Test (pid 12) "Window 8" [window_id: 8]' + (hidden.has(8) ? ' [off-screen]' : '') + '\n- Test (pid 12) "Window 9" [window_id: 9]' }] }
    else if (name === 'start_session') result = { content: [{ type: 'text', text: JSON.stringify({ session: 'implicit' }) }] }
    else if (name === 'get_window_state' && args.missing) result = { isError: true, content: [{ type: 'text', text: 'window no longer exists' }] }
    else if (name === 'get_window_state' && args.window_id === 9 && args.display_only) result = { isError: true, content: [{ type: 'text', text: 'capture refused' }] }
    else if (name === 'get_window_state' && args.emptytree) result = { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }], structuredContent: { app_name: 'Test', window_title: 'Window 7' } }
    else if (name === 'get_window_state') result = { content: [{ type: 'image', mimeType: 'image/png', data: args.window_id === 7 ? 'AAAA' : 'BBBB' }], structuredContent: { app_name: 'Test', window_title: `Window ${args.window_id}`, snapshot_id: `s${args.window_id}`, capture_id: `c${args.window_id}`, screenshot_width: 100, screenshot_height: 50 } }
    else result = { ...(args.refuse ? { isError: true } : {}), content: [{ type: 'text', text: 'ok' }], structuredContent: { effect: args.refuse ? 'refused' : 'confirmed' } }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
