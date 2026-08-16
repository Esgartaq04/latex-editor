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
