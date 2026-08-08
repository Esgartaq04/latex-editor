/**
 * Builds a flat `basename -> absolute path` index over a local TeX Live tree.
 *
 * kpathsea itself relies on basenames being effectively unique across
 * texmf-dist, which is what makes a flat static layout viable: one copy of each
 * file answers every kpathsea format code the engine asks under.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Trees worth indexing. `doc` and `source` are excluded — megabytes of PDFs. */
const DEFAULT_ROOTS = [
  "/usr/share/texlive/texmf-dist",
  "/usr/share/texmf",
  "/var/lib/texmf",
];

const SKIP_DIRECTORIES = new Set(["doc", "source", "texdoc", "texdoctk", "man", "info"]);

/**
 * When the same basename appears twice, keep the copy from the tree kpathsea
 * would have searched first. Higher score wins.
 */
function score(filePath) {
  if (filePath.includes("/tex/latex/")) return 100;
  if (filePath.includes("/tex/generic/")) return 90;
  if (filePath.includes("/tex/plain/")) return 80;
  if (filePath.includes("/tex/")) return 70;
  if (filePath.includes("/fonts/tfm/")) return 60;
  if (filePath.includes("/fonts/type1/")) return 55;
  if (filePath.includes("/fonts/opentype/")) return 50;
  if (filePath.includes("/fonts/")) return 45;
  if (filePath.includes("/web2c/")) return 40;
  if (filePath.includes("/bibtex/")) return 30;
  return 10;
}

export async function buildIndex(roots = DEFAULT_ROOTS) {
  /** @type {Map<string, string>} */
  const index = new Map();
  let collisions = 0;

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      // Distributions symlink generated files into place — Debian ships
      // pdftex.map as a link to pdftex_dl14.map — so links count as files.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(full);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // dangling link
        }
      }

      if (isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
      } else if (isFile) {
        const existing = index.get(entry.name);
        if (existing === undefined) {
          index.set(entry.name, full);
        } else if (score(full) > score(existing)) {
          collisions++;
          index.set(entry.name, full);
        } else {
          collisions++;
        }
      }
    }
  }

  for (const root of roots) {
    try {
      if ((await stat(root)).isDirectory()) await walk(root);
    } catch {
      // Root absent on this machine; the others may still cover what is needed.
    }
  }

  return { index, collisions };
}

export { DEFAULT_ROOTS };
