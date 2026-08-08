/*
 * TeXPane compile worker.
 *
 * The SwiftLaTeX engine build is itself a worker script — it installs its own
 * `onmessage` handler and speaks a small command protocol. All this entry point
 * does is pull in the resolver shim first, so the engine's TeX Live lookups are
 * already redirected at static assets by the time it runs.
 *
 * Kept as a hand-written classic worker in /public on purpose: `importScripts`
 * needs a classic worker, and routing a multi-megabyte WASM binary through the
 * bundler is slower and more fragile than serving it from the CDN.
 */
importScripts("./texlive-shim.js");
importScripts("./swiftlatexpdftex.js");
