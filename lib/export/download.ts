/**
 * File download helpers.
 *
 * Every object URL created here is revoked. A leaked one pins the whole PDF
 * buffer in memory for the life of the tab, which on a figure-heavy document is
 * tens of megabytes per download.
 */

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadTex(source: string, basename: string) {
  triggerDownload(new Blob([source], { type: "application/x-tex" }), `${basename}.tex`);
}

export function downloadPdf(pdf: Uint8Array, basename: string) {
  // Copy into a fresh buffer: the store's Uint8Array may be a view into a
  // larger transferred ArrayBuffer.
  const bytes = new Uint8Array(pdf);
  triggerDownload(
    new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
    `${basename}.pdf`,
  );
}

export async function downloadZip(
  source: string,
  pdf: Uint8Array | null,
  basename: string,
) {
  const { downloadZip: makeZip } = await import("client-zip");
  const files = [
    { name: "main.tex", lastModified: new Date(), input: source },
    ...(pdf
      ? [
          {
            name: `${basename}.pdf`,
            lastModified: new Date(),
            input: new Uint8Array(pdf),
          },
        ]
      : []),
  ];
  const blob = await makeZip(files).blob();
  triggerDownload(blob, `${basename}.zip`);
}

/**
 * Name downloads after the document's own title. `Untitled.pdf` six times in a
 * downloads folder is not a useful default.
 */
export function deriveBasename(source: string): string {
  const slug = extractTitle(source)
    .replace(/\\[a-zA-Z]+\s*/g, " ")
    .replace(/[{}$\\]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "document";
}

/**
 * Read the argument of `\title`, matching braces rather than stopping at the
 * first `}` — titles routinely contain markup like `\LaTeX{}`, and cutting
 * there would silently truncate the filename.
 */
function extractTitle(source: string): string {
  const start = /\\title\s*\{/.exec(source);
  if (!start) return "";

  let depth = 1;
  let index = start.index + start[0].length;
  const from = index;

  while (index < source.length && depth > 0) {
    const character = source[index];
    if (character === "\\") {
      index += 2; // an escaped brace is not a brace
      continue;
    }
    if (character === "{") depth++;
    else if (character === "}") depth--;
    index++;
  }

  return depth === 0 ? source.slice(from, index - 1) : "";
}
