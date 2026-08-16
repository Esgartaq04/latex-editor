#!/usr/bin/env node
/**
 * Compile a .tex file against the *shipped* static store, exactly as a visitor's
 * browser would, and report what it is missing.
 *
 *     node scripts/check-document.mjs path/to/document.tex
 *
 * Use this when someone reports a document that will not compile. It answers the
 * only question that matters — which files this store cannot supply — instead of
 * adding one package at a time and rebuilding in between.
 *
 * Nothing here touches the local TeX Live installation, so a document that
 * compiles under this tool will compile on the deployed site.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTexliveServer } from "./texlive-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-document.mjs <file.tex>");
  process.exit(2);
}

const source = await readFile(file, "utf8");
const server = await startTexliveServer({ mode: "static" });

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();

// The shim answers a miss locally, so the server never sees it. The engine logs
// every lookup it gives up on, which is the list we want.
const missing = new Set();
page.on("console", (message) => {
  const text = message.text();
  const match = /TexLive File not exists .*\/pdftex\/(?:pk\/)?[^/]+\/(.+)$/.exec(text);
  if (match) missing.add(match[1]);
});

try {
  await page.goto(`${server.origin}/harness.html`);
  await page.evaluate(
    ([endpoint, workerUrl]) => window.texpane.start(endpoint, workerUrl),
    [`${server.origin}/texlive/`, "/swiftlatex/texpane-engine.js"],
  );

  const result = await page.evaluate(([text]) => window.texpane.compile(text, 2), [source]);

  const { parseTexLog } = await import(path.join(root, "lib", "parseTexLog.ts"));
  const diagnostics = parseTexLog(result.log, source);

  console.log(`\n${path.basename(file)}: ${result.ok ? "compiles" : "FAILS"}\n`);

  if (!result.ok) {
    for (const diagnostic of diagnostics.filter((d) => d.severity === "error")) {
      console.log(`  ${diagnostic.line ? `line ${diagnostic.line}: ` : ""}${diagnostic.message}`);
    }
  }

  // Most misses are kpathsea probing speculatively for files that do not exist
  // anywhere. The ones worth acting on are those a real TeX Live has.
  const { buildIndex } = await import("./texlive-index.mjs");
  const { index } = await buildIndex().catch(() => ({ index: new Map() }));

  const actionable = [...missing].filter((name) => {
    if (index.has(name)) return true;
    return [".sty", ".cls", ".def", ".cfg", ".fd"].some((ext) => index.has(name + ext));
  });

  if (actionable.length) {
    console.log(
      `\n${actionable.length} file(s) exist in a full TeX Live but are not in the store:\n`,
    );
    for (const name of actionable.sort()) console.log(`  ${name}`);
    console.log("\nAdd a document using them to EXTRA_CORPUS and run `npm run texlive:build`.");
  } else if (!result.ok) {
    console.log("\nNothing is missing from the store — this is an error in the document.");
  }

  process.exitCode = result.ok ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
