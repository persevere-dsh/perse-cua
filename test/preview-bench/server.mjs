import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

/** Build the real client into a temporary directory and serve the isolated bench. */
export async function startBench(port = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'perse-preview-bench-'))
  let server
  try {
    await build({ config: false, entry: { bench: fileURLToPath(new URL('./main.jsx', import.meta.url)) }, outDir: directory, format: 'esm', platform: 'browser', dts: false, deps: { alwaysBundle: ['react', 'react-dom', 'scheduler', '@deepseek-ai/dsh-typert-protocol', 'zod'] }, outExtensions: () => ({ js: '.js' }) })
    const page = await readFile(new URL('./index.html', import.meta.url))
    const script = await readFile(join(directory, 'bench.js'))
    server = createServer((req, res) => {
      if (req.method !== 'GET' || !['/', '/bench.js'].includes(req.url)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(req.url === '/' ? page : script)
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    return { url: `http://127.0.0.1:${server.address().port}/`, async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { if (server?.listening) await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); throw error }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bench = await startBench(Number(process.env.PERSE_BENCH_PORT ?? 0))
  console.log(`Preview bench: ${bench.url}`)
  const stop = async () => { await bench.close(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
