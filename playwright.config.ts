import { defineConfig, devices } from "@playwright/test";

// Set BASE_PATH to the value the build used to exercise a GitHub Pages-style
// subpath deployment instead of a root one.
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/$/, "");
// Separate ports per mode: a root-mode server and a subpath-mode server serve
// different URLs, and letting them share a port makes a leftover from one run
// answer 404 for the next.
const PORT = BASE_PATH ? 3124 : 3123;

export default defineConfig({
  testDir: "./tests/e2e",
  // Compiling a real document in WebAssembly is not a millisecond operation,
  // and the first test also downloads a 22 MB format file.
  timeout: 180_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    // Origin only. A baseURL carrying a path is a trap: `goto("/")` is an
    // absolute path and would resolve back to the origin root, so a subpath
    // deployment would silently be tested at the wrong URL. The spec builds the
    // page path from BASE_PATH itself.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Lets a machine with a pre-installed Chromium skip Playwright's own
        // pinned download.
        launchOptions: process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `BASE_PATH=${BASE_PATH} node scripts/serve-static.mjs out ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}/`,
    // Never reuse: a server left over from a run with a different BASE_PATH
    // answers 404 for every page and the failures look like app bugs.
    // Starting this one costs milliseconds.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
