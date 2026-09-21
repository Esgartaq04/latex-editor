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
                                    │  /texlive/files/*                    │
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

| Host | Cost | Notes |
| --- | --- | --- |
| **GitHub Pages** | Free | Deployed by `.github/workflows/deploy-pages.yml`. Compresses every response on the fly, so the wire cost matches the table below with nothing to configure. See the setup step below — it needs one setting changed. |
| **Cloudflare Pages** | Free, **unlimited bandwidth** | `public/_headers` is already written for it. Build command `npm run build`, output directory `out`. |
| **Vercel Hobby** | Free, 100 GB/month | `vercel.json` is already written for it — roughly 11,000 cold visits a month before the cap. |
| **Netlify / S3 / any static host** | Free / pennies | Nothing host-specific is required. |

`Cache-Control: immutable` on `/swiftlatex/*`, `/pdfjs/*` and `/texlive/files/*` is what makes a repeat visit free. It is set in both config files; a host that ignores it still works, it just revalidates.

> **Do not pre-compress the TeX Live store and set `Content-Encoding: gzip` yourself.** It is tempting — the format dump is 21 MB raw against 5.6 MB gzipped — but hosts that compress on the fly then compress it *again*. The browser strips exactly one layer and hands the engine gzip bytes where it expected a font, and every document fails to compile. GitHub Pages does this to every response regardless of content type. Ship the files raw and let the host compress; the worst case is a host that does not, which costs bandwidth rather than breaking the site.

### Deploying to GitHub Pages

GitHub Pages defaults to "deploy from a branch", which runs Jekyll over the repository, renders `README.md` as the home page, and never builds the app. **Change Settings → Pages → Source to "GitHub Actions".** The workflow then builds the static export and publishes that.

Two details it handles that are easy to miss:

- A project site is served from `/<repo>/`, so the build sets `NEXT_PUBLIC_BASE_PATH` from the Pages configuration and every absolute asset URL — the WASM engine, the TeX Live store, the pdf.js worker — carries the prefix. Run the suite against a subpath build with `BASE_PATH=/latex-editor npx playwright test` after `NEXT_PUBLIC_BASE_PATH=/latex-editor npm run build`.
- `public/.nojekyll` stops Jekyll from stripping `_next/`, which it would otherwise drop for starting with an underscore, taking the entire app with it.

### Measured first visit

Taken from a real cold load of the built site, counting bytes on the wire with the host compressing:

| | Over the wire |
| --- | --- |
| Format file (`swiftlatexpdftex.fmt`) | 5.60 MB |
| WASM engine + glue | 1.78 MB |
| App JS/CSS | 1.10 MB |
| TeX Live files for this document (85 files) | 0.63 MB |
| **Total, first visit** | **9.14 MB** |
| **Total, repeat visit** | **~0** — everything above is `immutable` |

Uncompressed that same load is 28.8 MB. On a host that does not compress binary content types the site still works — it just costs 28.8 MB instead of 9.14 MB.

## The part the plan got wrong

The original design assumed SwiftLaTeX's engine could fetch missing packages from a TeX Live endpoint, with a serverless proxy and blob storage for the long tail. That assumption does not survive contact with reality:

**SwiftLaTeX bundles no TeX Live tree whatsoever.** The 1.8 MB WASM binary is the pdftex *program*. Every `.cls`, `.sty`, `.tfm`, font and even the format dump is fetched over HTTP at compile time. And both public endpoints it ships against are gone — `texlive.swiftlatex.com` no longer resolves, and `texlive2.swiftlatex.com` returns HTTP 522. Out of the box the engine cannot compile `\documentclass{article}`.

So this project hosts TeX Live itself, as static files:

**`scripts/build-texlive-cache.mjs`** does the work, in three phases:

1. **Discovery.** Index a local TeX Live installation, serve it over the engine's native protocol, and drive the real WASM engine in headless Chromium — first `compileformat` to produce `pdflatex.fmt` from *this* engine build, then a corpus of 26 realistic documents plus a smoke test per supported package, recording every file the engine asks for.
2. **Write.** Copy the recorded files to `public/texlive/files/`, trim the 5.1 MB font map down to the 177 entries whose fonts actually shipped, and write the manifest the browser shim resolves against.
3. **Verify.** Recompile the entire corpus against nothing but the generated store, through the same shim the deployed site uses.

The engine decides what ships, not a hand-written package list. Phase 3 is the point: a store is only useful if it is provably sufficient on its own.

Coverage comes from three sources. The curated corpus proves realistic *documents* work end to end, and `SMOKE_PACKAGES` gives every supported package a minimal document of its own — one package per document, so a package that cannot run in a browser engine fails alone instead of taking a batch down with it. A curated document failing is a build error; a smoke package failing is a warning, and that package is simply left off the supported list. `manifest.json` carries the list of packages that actually compiled, so what the store claims cannot drift from what it has.

The third source is `ALWAYS_INCLUDE_PATTERNS`, which ships whole font families regardless of what the corpus reached. Discovery cannot cover fonts the way it covers packages: TeX picks a design size from context, so `\texttt` inside a 12pt title wants cmtt12 while a footnote wants cmtt8, and a metric the store never fetched is not a degraded render — it is `Metric (TFM) file not found` and no PDF at all. Guessing which sizes a document will reach is a losing game, so Computer Modern, Latin Modern, and the EC/TC metrics ship complete, along with the cm-super outlines they re-encode. Metrics are nearly free; the outlines cost more, but a metric without its outline only moves the fatal error from load time to output time, so they travel together.

```bash
# Needs a local TeX Live and a Chromium. Output is committed, so a normal
# `npm run build` never runs this.
sudo apt-get install texlive-latex-recommended texlive-latex-extra \
                     texlive-fonts-recommended texlive-fonts-extra \
                     texlive-pictures texlive-plain-generic cm-super
npm run texlive:build
```

`cm-super` is not optional. It supplies Type 1 versions of the EC fonts, which is what `\usepackage[T1]{fontenc}` selects for any family a document does not override. Without it those fonts exist only as METAFONT sources, the engine asks for bitmaps, and a perfectly ordinary CV fails with `Font ectt1095 at 600 not found`.

Current store: **2,146 files, 69.5 MB on disk**, 40.0 MB once a host gzips it. A visitor only downloads the files their own document needs, so the store growing does not make anyone's page load slower.

### How lookups are resolved without a server

kpathsea asks for `cmr10` and encodes "this is a TFM" in a numeric format code — the extension is not in the request. The reference implementation resolves that server-side. `public/swiftlatex/texlive-shim.js` does it in the browser instead, by patching `XMLHttpRequest` inside the worker before the engine loads:

- `<endpoint>pdftex/<format>/<name>` is rewritten to a flat `<endpoint>files/<name>`, so one copy of each file serves every format code.
- The `fileid` response header the engine requires — which no static host can set per-file — is synthesised.
- Extensions are restored from the manifest, using both the exact rewrites recorded during the build and the extension each format code turned out to mean.
- **A miss is answered locally with a synthetic 301 and never touches the network.** This is the one that matters for speed: kpathsea probes far more names than it finds, and every probe is a *synchronous* blocking request.

Everything that is not a TeX Live lookup passes straight through to the native implementation.

### When a document will not compile

Check it against the shipped store, exactly as a visitor's browser would:

```bash
node scripts/check-document.mjs path/to/document.tex
```

It compiles the file through the real engine and the real shim, touching nothing but `public/texlive/`, and lists the files the store cannot supply — filtered to those a full TeX Live actually has, since kpathsea probes for far more names than exist. That is the whole answer in one run, rather than adding one package at a time and rebuilding in between.

To add what it reports: put a document exercising those packages in `EXTRA_CORPUS` in `scripts/build-texlive-cache.mjs` and re-run `npm run texlive:build`. The store grows by exactly what they need, and the verification phase proves the result still compiles everything else.

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

Fonts covered by the store: Computer Modern and Latin Modern complete, at every design size and in every shape, plus the EC/TC metrics for `T1` and `TS1` and the cm-super outlines behind them. On top of those, the PSNFSS families (Charter, Times/`mathptmx`, Palatino/`mathpazo`, Helvetica, Courier), `newtx`, Libertine and XCharter. Packages: the LaTeX base classes plus `beamer`, the AMS maths stack, and TikZ.

On top of those, 48 packages each have their own smoke test — tables (`colortbl`, `multirow`, `makecell`, `hhline`, `threeparttable`, `adjustbox`, `rotating`), boxes (`tcolorbox`, `mdframed`, `framed`), maths notation (`cancel`, `bm`, `mathrsfs`, `stmaryrd`, `dsfont`, `physics`, `xfrac`, `amscd`, `empheq`), proofs and algorithms (`bussproofs`, `algorithm2e`, `thmtools`), text and layout (`ulem`, `pifont`, `paralist`, `enumerate`, `cleveref`, `titling`, `todonotes`, `lipsum`), and drawing (`pgfplots`, `forest`, `circuitikz`, `mhchem`, `chemfig`). The authoritative list is the `packages` field of [`public/texlive/manifest.json`](public/texlive/manifest.json), generated from what compiled.

Known limits:

- **A package outside the store cannot be fetched at runtime.** There is no server to fetch it from — that is the trade for free hosting. The error panel names the package and points at the line that asked for it; adding it means a corpus entry and a rebuild.
- **BibTeX only, no Biber.** `bibtex` is compiled into the engine and runs automatically; `biber` is a separate binary and is not available.
- **TikZ/PGF is not in the shipped store.** It is a large dependency closure; add it to the corpus and rebuild if you need it.
- **XeTeX is not wired up.** Only the pdftex engine ships. The store and shim are engine-specific.
- **Safari has a lower per-tab WASM memory ceiling** than desktop Chrome. Large documents may fail there before they fail elsewhere.

## Deployment checklist

- [ ] `curl -I .../swiftlatex/swiftlatexpdftex.wasm` returns `Content-Type: application/wasm`
- [ ] `curl -s --compressed .../texlive/files/article.cls | head -3` shows **LaTeX source, not gzip bytes**. If it looks binary the store is being double-compressed and nothing will compile.
- [ ] `curl -I .../texlive/files/article.cls` returns `Cache-Control: immutable` (or the host's own long max-age)
- [ ] The page loads and the starter document renders — on a project site, at `/<repo>/`, not the root
- [ ] First load timed on a throttled connection — the format file is 5.6 MB and dominates
- [ ] Tested on Safari
