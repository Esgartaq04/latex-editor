import { test, expect, type Page } from "@playwright/test";

/**
 * The compilation pipeline can only be tested in a browser — it is WebAssembly
 * in a worker talking to a static file store. These tests exercise the loop the
 * whole product rests on: type, compile, see a PDF, download it.
 */

/**
 * Where the app is served. Matches the build's NEXT_PUBLIC_BASE_PATH so the
 * same suite covers a root deployment and a GitHub Pages project site.
 */
const HOME = `${(process.env.BASE_PATH ?? "").replace(/\/$/, "")}/`;

/** The starter document has to make it all the way to rendered canvases. */
async function waitForRender(page: Page) {
  await expect(page.locator('[data-testid="pdf-pages"] canvas').first()).toBeVisible({
    timeout: 150_000,
  });
}

test("compiles the starter document and renders a PDF", async ({ page }) => {
  await page.goto(HOME);

  await expect(page.getByTestId("editor")).toBeVisible();
  await waitForRender(page);

  await expect(page.getByTestId("status")).toContainText("Compiled", { timeout: 30_000 });
  // The starter document is two pages of real output, not a stub.
  expect(await page.locator('[data-testid="pdf-pages"] canvas').count()).toBeGreaterThan(0);
});

test("recompiles after an edit and keeps the scroll position", async ({ page }) => {
  await page.goto(HOME);
  await waitForRender(page);

  const scroller = page.getByTestId("pdf-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 200;
  });

  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" An added sentence.");

  await page.getByTestId("compile").click();
  await expect(page.getByTestId("status")).toContainText("Compiled", { timeout: 60_000 });

  // Recompiling must not yank the reader back to page one.
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("reports a syntax error against the right line", async ({ page }) => {
  await page.goto(HOME);
  await waitForRender(page);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(
    "\\documentclass{article}\n\\begin{document}\nHello\n\\undefinedmacro\n\\end{document}",
  );

  await page.getByTestId("compile").click();

  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText("Undefined control sequence");
  await expect(panel.getByRole("button", { name: /line 4/ })).toBeVisible();
});

test("downloads the source and the compiled PDF", async ({ page }) => {
  await page.goto(HOME);
  await waitForRender(page);

  const texDownload = page.waitForEvent("download");
  await page.getByTestId("download-tex").click();
  expect((await texDownload).suggestedFilename()).toMatch(/\.tex$/);

  const pdfDownload = page.waitForEvent("download");
  await page.getByTestId("download-pdf").click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);

  // A zero-byte or truncated PDF would still "download" — check it is real.
  const stream = await pdf.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
});

test("compiles a Charter résumé", async ({ page }) => {
  // A CV that switches the body font is the most common real document people
  // paste in, and it exercises the two things most likely to be missing: a
  // PSNFSS font package, and T1 text fonts for the families it does not
  // override (which need cm-super Type 1, not bitmaps).
  await page.goto(HOME);
  await waitForRender(page);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(
    [
      "\\documentclass[11pt]{article}",
      "\\usepackage[margin=0.75in]{geometry}",
      "\\usepackage{charter}",
      "\\usepackage[T1]{fontenc}",
      "\\usepackage{enumitem}",
      "\\usepackage[hidelinks]{hyperref}",
      "\\pagestyle{empty}",
      "\\begin{document}",
      "\\begin{center}{\\LARGE \\textbf{Your Name}}\\end{center}",
      "\\section*{Experience}",
      "\\begin{itemize}[leftmargin=*]",
      "\\item Shipped \\texttt{something} measurable.",
      "\\end{itemize}",
      "\\end{document}",
    ].join("\n"),
  );

  await page.getByTestId("compile").click();
  await expect(page.getByTestId("status")).toContainText("Compiled", { timeout: 90_000 });
  expect(await page.locator('[data-testid="pdf-pages"] canvas').count()).toBeGreaterThan(0);
});

test("names the package when one is genuinely missing", async ({ page }) => {
  await page.goto(HOME);
  await waitForRender(page);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(
    [
      "\\documentclass{article}",
      "\\usepackage{definitelynotarealpackage}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "Hi",
      "\\end{document}",
    ].join("\n"),
  );

  await page.getByTestId("compile").click();

  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel).toContainText("definitelynotarealpackage");
  await expect(panel).toContainText("not in this editor's TeX Live bundle");
  // Line 2 is the \usepackage, not line 3 where TeX actually stopped.
  await expect(panel.getByRole("button", { name: /line 2/ })).toBeVisible();
});

test("restores the document from IndexedDB after a reload", async ({ page }) => {
  await page.goto(HOME);
  await waitForRender(page);

  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Persisted marker.");

  await expect(page.getByTestId("status")).toContainText("Saved", { timeout: 30_000 });

  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("Persisted marker.", {
    timeout: 60_000,
  });
});
