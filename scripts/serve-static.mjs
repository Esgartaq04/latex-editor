#!/usr/bin/env node
/**
 * Serves the exported site for local checks and end-to-end tests.
 *
 * The production deployment is a CDN, not this — but it applies the same cache
 * headers the CDN is configured with, so caching behaviour can be checked
 * locally.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? process.env.PORT ?? 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const IMMUTABLE = /^\/(swiftlatex|pdfjs|texlive\/files|_next\/static)\//;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  let file = path.join(directory, pathname);
  if (!file.startsWith(directory)) {
    res.writeHead(400).end("bad path");
    return;
  }

  try {
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": IMMUTABLE.test(pathname)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
      // The TeX Live store is committed pre-compressed — see vercel.json and
      // public/_headers for the same rule on the real hosts.
      ...(pathname.startsWith("/texlive/files/") ? { "content-encoding": "gzip" } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`Serving ${directory} on http://localhost:${port}`);
});
