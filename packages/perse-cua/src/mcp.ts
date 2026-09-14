/**
 * A minimal MCP stdio client, specialised for one job: talking to `cua-driver`
 * so this plugin can own the tool surface it exposes.
 *
 * It is deliberately smaller than a general MCP client. It speaks the
 * line-delimited JSON-RPC 2.0 that `cua-driver mcp` uses, handles exactly the
 * three methods the bridge needs (`initialize`, `tools/list`, `tools/call`), and
 * treats any server-initiated request as unsupported rather than inventing a
 * handler for it. There is no reconnect: a cua-driver process that dies is
 * replaced by the plugin's own respawn on the next call.
 *
 * @module perse-cua/mcp
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** One MCP tool as advertised by the server. */
export interface McpTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

/** One content block returned by `tools/call`. */
export interface McpContentBlock {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** The `tools/call` result this plugin consumes. */
export interface McpCallResult {
  readonly content: readonly McpContentBlock[]
  readonly isError?: boolean
  readonly structuredContent?: unknown
}

/** Transport-level failure, distinct from a tool that returned `isError`. */
export class McpTransportError extends Error {
  override readonly name = 'McpTransportError'
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Options for {@link McpStdioClient}. */
export interface McpStdioClientOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly requestTimeoutMs?: number
  readonly startupTimeoutMs?: number
  /** Receives the child's stderr, already line-split, for host-side logging. */
  readonly onStderr?: (line: string) => void
}

/**
 * One live `cua-driver mcp` process.
 *
 * Not safe to share across an await boundary during construction: call
 * {@link start} once and reuse the resolved client.
 */
export class McpStdioClient {
  private readonly options: McpStdioClientOptions
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed: Error | undefined

  constructor(options: McpStdioClientOptions) {
    this.options = options
  }

  /** Spawn the server and complete the MCP handshake. */
  async start(): Promise<void> {
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line !== '') this.dispatch(line)
        newline = this.buffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.options.onStderr?.(line.trim())
      }
    })

    child.on('error', (error: Error) => this.fail(new McpTransportError(`cua-driver failed to start: ${error.message}`)))
    child.on('close', (code) => this.fail(new McpTransportError(`cua-driver exited (code ${String(code)})`)))

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'perse-cua', version: '0.1.0' },
    }, this.options.startupTimeoutMs ?? 30_000)
    this.notify('notifications/initialized')
  }

  /** Advertised tools, in server order. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  /** Invoke one tool by its wire name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }) as McpCallResult
    return { content: result.content ?? [], ...(result.isError === undefined ? {} : { isError: result.isError }), ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) }
  }

  /** Terminate the child; safe to call more than once. */
  close(): void {
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill()
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    const id = this.nextId++
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpTransportError(`cua-driver did not answer ${method} within ${effectiveTimeout}ms`))
      }, effectiveTimeout)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new McpTransportError(`cua-driver write failed: ${String(error)}`))
      }
    })
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    // A server-initiated request would need a handler this client does not have;
    // answering with an error keeps the server from waiting on it forever.
    if (message.method !== undefined && message.id !== undefined) {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `perse-cua does not implement ${message.method}` } })}\n`)
      return
    }
    if (message.id === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new McpTransportError(message.error.message ?? 'cua-driver returned an error'))
    else entry.resolve(message.result)
  }

  private fail(error: Error): void {
    this.closed = error
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
