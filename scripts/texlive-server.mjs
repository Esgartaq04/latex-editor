/**
 * A local stand-in for the TeX Live file store.
 *
 * Serves the app's static assets plus every file in a local TeX Live tree under
 * the same flat `/texlive/files/<name>` layout the deployed CDN uses, and
 * records which names the engine actually asks for. That recording is what the
 * cache builder turns into the shipped subset.
 *
 * This is a build-time tool. Nothing here is deployed.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "./texlive-index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * kpathsea drops the extension and encodes it in the numeric format code, so
 * `cmr10` under the TFM format means `cmr10.tfm`. Rather than hard-code the
 * kpathsea enum (which differs between engine builds), candidates are tried in
 * this order and the extension that actually resolved is recorded per format
 * code. The build writes those observations into the manifest, so the browser
 * resolves the same way without ever guessing.
 *
 * Ordered by how often pdftex asks for each kind of file.
 */
const CANDIDATE_EXTENSIONS = [
  ".tfm", ".tex", ".sty", ".cls", ".def", ".cfg", ".clo", ".fd", ".ltx",
  ".enc", ".map", ".vf", ".pfb", ".ofm", ".ovf", ".otf", ".ttf", ".pro",
  ".fmt", ".bst", ".bib", ".cnf", ".ist", ".sfd", ".lig", ".ini", ".lua",
];

/** Per-format overrides; empty means "use the candidate list". */
const FORMAT_EXTENSIONS = {};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

/**
 * @param {object} options
 * @param {"discovery"|"static"} [options.mode]
 *   `discovery` serves a whole local TeX Live tree and records what the engine
 *   asks for. `static` serves only what has been written to public/, which is
 *   exactly what the deployed site serves — used to verify the generated store
 *   before it is committed.
 */
export async function startTexliveServer({ port = 0, overlay = new Map(), mode = "discovery" } = {}) {
  const { index, collisions } =
    mode === "discovery" ? await buildIndex() : { index: new Map(), collisions: 0 };
  /** Names the engine successfully fetched. */
  const used = new Set();
  /** Names the engine asked for and did not get. */
  const missing = new Set();
  /** Every lookup, for deriving the format table. */
  const lookups = [];
  /** `"<format>/<requested>" -> "<stored name>"` where kpathsea left the extension off. */
  const aliases = new Map();

  function resolveName(format, requested) {
    if (requested.includes("/")) return null;
    if (overlay.has(requested) || index.has(requested)) return requested;
    for (const extension of FORMAT_EXTENSIONS[format] ?? CANDIDATE_EXTENSIONS) {
      const candidate = requested + extension;
      if (overlay.has(candidate) || index.has(candidate)) return candidate;
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    // Native SwiftLaTeX protocol: /texlive/pdftex/<kpse-format>/<name>.
    // The discovery harness talks to the engine directly (no shim) so the
    // format code — which is what carries the file extension kpathsea left off
    // — is visible here and can be recorded.
    if (mode === "discovery" && pathname.startsWith("/texlive/pdftex/")) {
      const rest = pathname.slice("/texlive/pdftex/".length);

      if (rest.startsWith("pk/")) {
        res.writeHead(301).end("no bitmap fonts");
        return;
      }

      const slash = rest.indexOf("/");
      if (slash < 0) {
        res.writeHead(301).end("bad lookup");
        return;
      }
      const format = rest.slice(0, slash);
      const requested = rest.slice(slash + 1);
      const resolved = resolveName(format, requested);

      lookups.push({ format, requested, resolved });

      if (!resolved) {
        missing.add(`${format}/${requested}`);
        // 301, not 404: the engine only caches a miss on 301.
        res.writeHead(301).end("not found");
        return;
      }

      try {
        const source = overlay.get(resolved) ?? index.get(resolved);
        const body = Buffer.isBuffer(source) ? source : await readFile(source);
        used.add(resolved);
        if (resolved !== requested) aliases.set(`${format}/${requested}`, resolved);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          fileid: resolved,
        });
        res.end(body);
      } catch {
        missing.add(`${format}/${requested}`);
        res.writeHead(301).end("not found");
      }
      return;
    }

    // Flat layout, as served in production. In static mode these are ordinary
    // files under public/ and fall through to the static handler below.
    if (mode === "discovery" && pathname.startsWith("/texlive/files/")) {
      const name = pathname.slice("/texlive/files/".length);
      const source = overlay.get(name) ?? index.get(name);
      if (!source) {
        missing.add(name);
        res.writeHead(404).end("not found");
        return;
      }
      try {
        const body = Buffer.isBuffer(source) ? source : await readFile(source);
        used.add(name);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          fileid: name,
        });
        res.end(body);
      } catch {
        missing.add(name);
        res.writeHead(404).end("not found");
      }
      return;
    }

    // No manifest during discovery: the engine must ask about every name so the
    // server can observe the full set of lookups.
    if (mode === "discovery" && pathname === "/texlive/manifest.json") {
      res.writeHead(404).end("no manifest");
      return;
    }

    // The discovery harness is a build-time page, so it is served from
    // scripts/ rather than public/ — it must never end up in the deployment.
    if (pathname === "/harness.html") {
      const body = await readFile(path.join(root, "scripts", "harness.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(body);
      return;
    }

    const file = path.join(root, "public", pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(path.join(root, "public"))) {
      res.writeHead(400).end("bad path");
      return;
    }
    try {
      await stat(file);
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();

  return {
    origin: `http://127.0.0.1:${address.port}`,
    index,
    collisions,
    used,
    missing,
    lookups,
    aliases,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// `npm run texlive:serve` — handy for poking at the engine by hand.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const server = await startTexliveServer({ port: Number(process.env.PORT ?? 8787) });
  console.log(`TeX Live store on ${server.origin} (${server.index.size} files indexed)`);
}
