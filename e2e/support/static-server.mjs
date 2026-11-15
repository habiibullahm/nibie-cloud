// Serves the landing page export (apps/landing/out) the way Cloudflare static assets do:
// /harga -> harga.html, unknown path -> 404.html with status 404. No dependencies.
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"

const root = resolve(process.argv[2] ?? "../apps/landing/out")
const port = Number(process.argv[3] ?? 3300)
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
}

async function isFile(p) {
  try { return (await stat(p)).isFile() } catch { return false }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const rel = normalize(path).replace(/^([/\\])+/, "")
  const base = join(root, rel)
  if (!base.startsWith(root)) { res.writeHead(403).end(); return }
  const candidates = [base, `${base}.html`, join(base, "index.html")]
  for (const c of candidates) {
    if (await isFile(c)) {
      res.writeHead(200, { "content-type": types[extname(c)] ?? "application/octet-stream" })
      res.end(await readFile(c))
      return
    }
  }
  res.writeHead(404, { "content-type": types[".html"] })
  res.end(await readFile(join(root, "404.html")).catch(() => "not found"))
}).listen(port, "127.0.0.1", () => console.log(`landing export on http://127.0.0.1:${port}`))
