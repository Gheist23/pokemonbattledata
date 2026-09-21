// Local test server: the static site plus the real sync Functions.
//
//   node tests/dev-server.mjs            (http://127.0.0.1:8790)
//
// `wrangler pages dev` has to scan ~20,000 files on every start; this serves
// the folder directly and routes /api/sync* to functions/api/sync with an
// in-memory KV, which is all the Team Builder and the Companion's sync need.
// Not deployed: tests/ is in deploy.mjs's devOnlyPaths.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT || 8790);
const kv = new Map();
const env = {
  SYNC: {
    async get(key) { return kv.has(key) ? kv.get(key) : null; },
    async put(key, value) { kv.set(key, String(value)); },
  },
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".csv": "text/csv; charset=utf-8" };
const syncIndex = await import(pathToFileURL(join(root, "functions/api/sync/index.js")).href);
const syncCode = await import(pathToFileURL(join(root, "functions/api/sync/[code].js")).href);

async function toRequest(req, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
}

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/sync" || url.pathname === "/api/sync/") {
      if (req.method !== "POST") return send(res, new Response("", { status: 405 }));
      return send(res, await syncIndex.onRequestPost({ request: await toRequest(req, url), env }));
    }
    const match = url.pathname.match(/^\/api\/sync\/([^/]+)$/);
    if (match) {
      const params = { code: decodeURIComponent(match[1]) };
      const request = await toRequest(req, url);
      if (req.method === "GET") return send(res, await syncCode.onRequestGet({ request, params, env }));
      if (req.method === "PUT") return send(res, await syncCode.onRequestPut({ request, params, env }));
      return send(res, new Response("", { status: 405 }));
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(root, path);
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": types[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error.stack || error));
  }
}).listen(port, "127.0.0.1", () => console.log(`dev server on http://127.0.0.1:${port}`));
