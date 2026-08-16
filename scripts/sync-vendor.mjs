#!/usr/bin/env node
/**
 * Pulls the third-party binaries that are served as static assets rather than
 * bundled:
 *
 *   - the SwiftLaTeX pdftex engine (JS glue + WASM), from the project's own
 *     distribution;
 *   - the pdf.js worker, copied out of node_modules so its version can never
 *     drift from the `pdfjs-dist` the app imports.
 *
 * Run after `npm install`, or whenever you bump `pdfjs-dist`.
 */

import { createWriteStream } from "node:fs";
import { mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENGINE_BASE = process.env.SWIFTLATEX_BASE ?? "https://www.swiftlatex.com/";
const ENGINE_FILES = ["swiftlatexpdftex.js", "swiftlatexpdftex.wasm"];

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function main() {
  const engineDir = path.join(root, "public", "swiftlatex");
  await mkdir(engineDir, { recursive: true });

  for (const name of ENGINE_FILES) {
    const destination = path.join(engineDir, name);
    if (!process.env.FORCE && (await exists(destination))) {
      console.log(`· ${name} already present`);
      continue;
    }
    process.stdout.write(`↓ ${name} … `);
    await download(ENGINE_BASE + name, destination);
    const { size } = await stat(destination);
    console.log(`${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  // Recorded so the loading UI can show a percentage. Content-Length is no help:
  // hosts that compress on the fly report the compressed size while the browser
  // hands the reader decompressed bytes.
  const { size: wasmBytes } = await stat(path.join(engineDir, "swiftlatexpdftex.wasm"));
  await writeFile(
    path.join(engineDir, "engine.json"),
    JSON.stringify({ wasm: "swiftlatexpdftex.wasm", bytes: wasmBytes }) + "\n",
  );

  const pdfjsDir = path.join(root, "public", "pdfjs");
  await mkdir(pdfjsDir, { recursive: true });
  const worker = path.join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
  if (!(await exists(worker))) {
    throw new Error("pdfjs-dist is not installed; run `npm install` first.");
  }
  await copyFile(worker, path.join(pdfjsDir, "pdf.worker.min.mjs"));
  console.log("· pdf.worker.min.mjs copied from node_modules");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
