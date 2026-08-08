# TeXPane

A browser-based LaTeX editor with a split-pane interface: LaTeX source on the left, a live-rendered PDF on the right. Write or paste LaTeX, watch the output rebuild as you type, and download the `.tex` and the compiled `.pdf`.

A real TeX engine — pdftex, compiled to WebAssembly — runs in the visitor's browser. Nothing is uploaded, nothing is installed, and **the deployment is a pile of static files with no server-side compute at all.**

```
┌──────────────────────────────── Browser ──────────────────────────────────┐
│                                                                            │
│  ┌────────────────┐   debounced 800ms   ┌──────────────────────────────┐  │
│  │ CodeMirror 6   │ ──────────────────► │ Web Worker                   │  │
│  │ (main thread)  │      source         │  ┌────────────────────────┐  │  │
│  │                │                     │  │ texlive-shim.js        │  │  │
│  │ syntax +       │                     │  │  rewrites kpathsea     │  │  │
│  │ inline lint    │                     │  │  lookups to static URLs│  │  │
│  └────────────────┘                     │  ├────────────────────────┤  │  │
│         ▲                               │  │ SwiftLaTeX pdftex WASM │  │  │
│         │ Zustand store                 │  │  in-memory FS, PDF+log │  │  │
│         ▼                               │  └───────────┬────────────┘  │  │
│  ┌────────────────┐  ◄──────────────────└──────────────┼───────────────┘  │
│  │ pdf.js canvas  │      PDF bytes + log               │                  │
│  └────────────────┘                                    │ cache miss only  │
└────────────────────────────────────────────────────────┼──────────────────┘
                                    ┌───────────────────▼──────────────────┐
                                    │  Static CDN — no functions           │
                                    │  /swiftlatex/*.wasm                  │
                                    │  /texlive/files/*   (gzipped)        │
                                    │  /texlive/manifest.json              │
                                    └──────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run sync:vendor     # fetch the WASM engine + pdf.js worker into public/
npm run dev             # http://localhost:3000
```

`npm run build` writes a static site to `out/`. That directory is the entire deployment.

```bash
npm run build
npm start               # serve out/ locally with production cache headers
npm test                # unit tests (log parsing, filename derivation)
npm run test:e2e        # Playwright: type → compile → render → download
```

## Hosting, and what it costs

**Nothing, on any static host.** Compilation happens on the visitor's device, so there is no function to invoke, no container to keep warm, no database, and no per-user cost. The build output is HTML, JS, WASM and a directory of TeX Live files.

Recommended, cheapest first:

| Host | Cost | Notes |
| --- | --- | --- |
| **Cloudflare Pages** | Free, **unlimited bandwidth** | The cheapest option that stays cheap. `public/_headers` is already written for it. Build command `npm run build`, output directory `out`. |
| **Vercel Hobby** | Free, 100 GB/month | `vercel.json` is already written for it. At the measured first-visit cost that is roughly 11,000 cold visits a month before the cap. |
| **GitHub Pages / Netlify / S3** | Free / pennies | Any host that serves files and lets you set two response headers works. |

The two headers that matter are in both config files, and a host that cannot set them is the one thing that will break a deployment:

- `Content-Encoding: gzip` on `/texlive/files/*` — the store is committed pre-compressed (see below).
- `Cache-Control: immutable` on `/swiftlatex/*`, `/pdfjs/*` and `/texlive/files/*` — this is what makes a repeat visit free.

### Measured first visit

Taken from a real cold load of the built site, counting bytes on the wire:

| | Over the wire |
| --- | --- |
| Format file (`swiftlatexpdftex.fmt`, gzipped) | 5.60 MB |
| WASM engine + glue | 1.78 MB |
| App JS/CSS | 1.10 MB |
| TeX Live files for this document (85 files, gzipped) | 0.63 MB |
| **Total, first visit** | **9.14 MB** |
| **Total, repeat visit** | **~0** — everything above is `immutable` |

Uncompressed that same load is 28.8 MB, which is why the store ships pre-compressed rather than trusting a host to compress a binary content type.

## The part the plan got wrong

The original design assumed SwiftLaTeX's engine could fetch missing packages from a TeX Live endpoint, with a serverless proxy and blob storage for the long tail. That assumption does not survive contact with reality:

**SwiftLaTeX bundles no TeX Live tree whatsoever.** The 1.8 MB WASM binary is the pdftex *program*. Every `.cls`, `.sty`, `.tfm`, font and even the format dump is fetched over HTTP at compile time. And both public endpoints it ships against are gone — `texlive.swiftlatex.com` no longer resolves, and `texlive2.swiftlatex.com` returns HTTP 522. Out of the box the engine cannot compile `\documentclass{article}`.

So this project hosts TeX Live itself, as static files:

**`scripts/build-texlive-cache.mjs`** does the work, in three phases:

1. **Discovery.** Index a local TeX Live installation, serve it over the engine's native protocol, and drive the real WASM engine in headless Chromium — first `compileformat` to produce `pdflatex.fmt` from *this* engine build, then a corpus of 13 documents, recording every file the engine asks for.
2. **Write.** Copy the recorded files to `public/texlive/files/`, gzip them, trim the 4.9 MB font map down to the 92 entries whose fonts actually shipped, and write a manifest.
3. **Verify.** Recompile the entire corpus against nothing but the generated store, through the same shim the deployed site uses.

The engine decides what ships, not a hand-written package list. Phase 3 is the point: a store is only useful if it is provably sufficient on its own.

```bash
# Needs a local TeX Live and a Chromium. Output is committed, so a normal
# `npm run build` never runs this.
sudo apt-get install texlive-latex-recommended texlive-latex-extra \
                     texlive-fonts-recommended texlive-pictures
npm run texlive:build
```

Current store: **348 files, 9.6 MB gzipped** (28.5 MB decompressed).

### How lookups are resolved without a server

kpathsea asks for `cmr10` and encodes "this is a TFM" in a numeric format code — the extension is not in the request. The reference implementation resolves that server-side. `public/swiftlatex/texlive-shim.js` does it in the browser instead, by patching `XMLHttpRequest` inside the worker before the engine loads:

- `<endpoint>pdftex/<format>/<name>` is rewritten to a flat `<endpoint>files/<name>`, so one copy of each file serves every format code.
- The `fileid` response header the engine requires — which no static host can set per-file — is synthesised.
- Extensions are restored from the manifest, using both the exact rewrites recorded during the build and the extension each format code turned out to mean.
- **A miss is answered locally with a synthetic 301 and never touches the network.** This is the one that matters for speed: kpathsea probes far more names than it finds, and every probe is a *synchronous* blocking request.

Everything that is not a TeX Live lookup passes straight through to the native implementation.

### Adding package support

Add a document exercising the packages to `EXTRA_CORPUS` in `scripts/build-texlive-cache.mjs`, then re-run `npm run texlive:build`. The store grows by exactly what those packages need. If a package is missing at runtime the log says so and the error panel surfaces it.

## Project layout

```
app/                      Next.js App Router — one static route
components/
  Workspace.tsx           Layout, theme, mobile tabs, engine lifecycle
  Editor.tsx              CodeMirror 6, mounted imperatively
  PdfPreview.tsx          pdf.js, scroll-preserving re-render
  Toolbar.tsx             Compile, templates, downloads, theme
  ErrorPanel.tsx          Parsed diagnostics, raw log behind a toggle
  StatusBar.tsx           Engine download progress, pass counter
lib/
  compiler/engine.ts      Worker wrapper: watchdog, multi-pass, prefetch
  store/editorStore.ts    Zustand state machine + debounces
  parseTexLog.ts          pdftex log → structured diagnostics
  export/download.ts      .tex / .pdf / .zip, filename derivation
  persistence.ts          IndexedDB autosave
public/
  swiftlatex/             Vendored engine + the resolver shim + worker entry
  texlive/                Generated store: files/ and manifest.json
scripts/
  build-texlive-cache.mjs Discovery → write → verify
  texlive-server.mjs      Build-time TeX Live server (not deployed)
  sync-vendor.mjs         Fetch engine + pdf.js worker
```

## Implementation notes

Decisions that are load-bearing and easy to undo by accident:

**No COOP/COEP.** The engine build uses no `SharedArrayBuffer` and no pthreads, so cross-origin isolation is unnecessary — and it would break third-party embeds for nothing. Verified by inspecting the engine binary's glue code.

**The watchdog is not optional.** TeX is Turing-complete; `\def\x{\x}\x` spins the worker forever and only `terminate()` from the main thread can recover it. Every compile is wrapped in a 30-second timeout that kills the worker and spawns a fresh one.

**`compileId` guards every result.** If a compile finishes after a newer one started, its result is dropped. Without that, the preview flickers backwards while you type.

**Scroll position is restored absolutely, not proportionally.** An edit on page 1 must not move page 12 under the reader.

**Multi-pass is driven by the log.** `\tableofcontents`, `\ref` and `\cite` need two or three passes; the engine keeps its virtual filesystem between calls, so `.aux` survives and re-running is just sending `compilelatex` again. Capped at three.

**`settexliveurl` and `setmainfile` send no reply.** They only assign a variable in the worker. Awaiting them deadlocks.

**PDF export is gated on `status === "success"`.** Handing someone the previous PDF after a failed recompile is a genuinely confusing bug.

**Auto-compile disables itself above 1,500 lines,** rather than freezing the tab when someone pastes a thesis.

## Status against the original MVP

Shipped (P0 and P1): split pane with persisted ratio, CodeMirror 6 with LaTeX highlighting, debounced worker compilation, pdf.js preview with preserved scroll, `.tex`/`.pdf`/`.zip` download, error panel with line numbers wired into the editor's lint gutter, IndexedDB autosave with restore, starter document, engine download progress with real byte counts, manual compile and ⌘S, template picker, dark mode, mobile tab layout.

Not shipped: KaTeX draft tier, image upload, multi-file projects, share-by-URL. Collaboration, accounts, SyncTeX and Biber remain out of scope.

Known limits:

- **BibTeX only, no Biber.** `bibtex` is compiled into the engine and runs automatically; `biber` is a separate binary and is not available.
- **TikZ/PGF is not in the shipped store.** It is a large dependency closure; add it to the corpus and rebuild if you need it.
- **XeTeX is not wired up.** Only the pdftex engine ships. The store and shim are engine-specific.
- **Safari has a lower per-tab WASM memory ceiling** than desktop Chrome. Large documents may fail there before they fail elsewhere.

## Deployment checklist

- [ ] `curl -I .../swiftlatex/swiftlatexpdftex.wasm` returns `Content-Type: application/wasm`
- [ ] `curl -I .../texlive/files/article.cls` returns `Content-Encoding: gzip` **and** `Cache-Control: immutable`
- [ ] `curl -s .../texlive/files/article.cls | file -` says gzip, and the browser renders the starter document
- [ ] First load timed on a throttled connection — the format file is 5.6 MB and dominates
- [ ] Tested on Safari
