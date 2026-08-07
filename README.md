# Project Overview

**Working name:** `TeXPane` (rename at will)

A browser-based LaTeX editor with a split-pane interface: LaTeX source on the left, a live-rendered document on the right. Users can write or paste LaTeX, watch the output update as they type, and export both the `.tex` source and a compiled `.pdf`. The entire application is deployed on Vercel.

## Goals

| Goal | Why it matters |
| --- | --- |
| **Zero-install LaTeX** | The single biggest friction point in LaTeX is the 5 GB TeX Live install. Removing it is the whole product. |
| **Sub-second feedback loop** | Overleaf's server round-trip is 2–8s. Compiling locally in the browser can get this to ~300–800ms on warm cache. |
| **True PDF fidelity** | Output must be byte-comparable to `pdflatex`/`xelatex` — not an HTML approximation. Anything less fails for thesis/paper submission. |
| **No per-user server cost** | Compilation happens on the user's device. The Vercel deployment stays inside the free/hobby tier indefinitely. |

## Non-goals (v1)

- Real-time multi-user collaboration (Yjs is a Phase 6 stretch — architecture leaves room for it).
- Account systems, cloud project storage, or a document library.
- Full BibTeX/Biber bibliography pipelines (see *Potential Challenges*).
- Mobile-first editing. It should not *break* on mobile, but the target is desktop.

## Success criteria for v1

1. Paste a standard `article`-class document with math, sections, and a table → correct PDF in under 3 seconds cold, under 1 second warm.
2. Syntax errors surface a readable message pointing at the right line, not a raw TeX log dump.
3. Both `.tex` and `.pdf` download correctly in Chrome, Firefox, and Safari.
4. Deployed on Vercel with a green Lighthouse performance score on the landing route.

---

# Proposed Architecture & Tech Stack

## The core architectural decision

This is the question the whole project hinges on, so it's worth being explicit about why the obvious answer is wrong.

**The tempting approach — a serverless function running `pdflatex` — does not work on Vercel.** Three hard limits kill it:

| Vercel limit | Value | Why it blocks server-side TeX |
| --- | --- | --- |
| Function bundle size (uncompressed) | **250 MB** | A full TeX Live install is ~5–7 GB. Even `texlive-small` is ~350 MB. You'd have to hand-prune a distribution and would still break the moment a user needs `tikz` or a font you didn't ship. |
| Function duration | 300s (Hobby, Fluid Compute) / 800s (Pro) | Actually *fine* for TeX. This is not the blocker people assume it is. |
| Ephemeral scratch space | 500 MB | Workable but tight once you add aux files and fonts. |
| Cold start | Multi-second on a 200 MB bundle | Every first compile pays it. |

The duration limit is the one everybody worries about and it's the least important. **The bundle size limit is what actually makes server-side TeX on Vercel unviable.**

### The recommendation: client-side WebAssembly compilation

Compile LaTeX **in the user's browser** using a WASM-compiled TeX engine, running inside a Web Worker.

**Engine: SwiftLaTeX.** It ships `PdfTeXEngine` and `XeTeXEngine` compiled to WebAssembly. The XeTeX engine is derived from Tectonic (the C++ reimplementation of XeTeX), which is why "use Tectonic" and "use SwiftLaTeX" are closer to the same answer than they sound — SwiftLaTeX is the packaged, browser-ready form of that lineage. It runs roughly 2× slower than a native binary, which for a typical 10-page document means a few hundred milliseconds.

```
┌─────────────────────────────────────── Browser ────────────────────────────────────────┐
│                                                                                         │
│  ┌──────────────────┐    debounced     ┌─────────────────────────────────────────────┐ │
│  │  CodeMirror 6    │    source text   │  Web Worker                                 │ │
│  │  (main thread)   │ ───────────────► │  ┌───────────────────────────────────────┐  │ │
│  │                  │                  │  │  SwiftLaTeX XeTeXEngine (WASM)        │  │ │
│  │  syntax          │                  │  │  ├─ in-memory FS (MemFS)              │  │ │
│  │  highlighting    │                  │  │  ├─ compile → Uint8Array PDF + log    │  │ │
│  │  linting         │                  │  │  └─ missing package? → fetch          │  │ │
│  └──────────────────┘                  │  └──────────────────┬────────────────────┘  │ │
│           │                            └─────────────────────┼───────────────────────┘ │
│           │ Zustand store                        PDF bytes   │                         │
│           ▼                                       + log      │                         │
│  ┌──────────────────┐  ◄───────────────────────────────────  │                         │
│  │  pdf.js viewer   │                                        │                         │
│  │  (canvas)        │                                        │                         │
│  └──────────────────┘                                        │                         │
└──────────────────────────────────────────────────────────────┼─────────────────────────┘
                                                               │ only on cache miss
                                     ┌─────────────────────────▼─────────────────────────┐
                                     │  Vercel                                           │
                                     │  ├─ /public/swiftlatex/*.wasm  (CDN, immutable)   │
                                     │  ├─ /public/texlive-cache/*    (pre-baked bundle) │
                                     │  └─ /api/texlive/[...path]     (proxy + Blob)     │
                                     └───────────────────────────────────────────────────┘
```

### The catch nobody mentions, and how to solve it

**SwiftLaTeX does not bundle a complete TeX Live distribution.** It ships the engine and a minimal core. When a document does `\usepackage{tikz}`, the engine calls out to a configured "TeX Live on-demand" endpoint to fetch the missing `.sty` and font files. The reference implementation of that endpoint is a Docker container — which you *cannot* run on Vercel.

This is the part of the architecture you have to design yourself, and it's the difference between a demo and a working product. Three-tier solution:

**Tier 1 — Pre-baked static cache (covers ~85% of documents).**
Build-time script that resolves the dependency closure of the 40–60 most common packages (`amsmath`, `amssymb`, `geometry`, `graphicx`, `hyperref`, `booktabs`, `xcolor`, `enumitem`, `natbib`, `babel`, plus Computer Modern and Latin Modern fonts) and writes them to `/public/texlive-cache/`. These ship on Vercel's CDN as immutable static assets. No function invocation, no cold start, no cost.

**Tier 2 — On-demand proxy route (covers the long tail).**
```
app/api/texlive/[...path]/route.ts
```
A thin Node-runtime route that: checks Vercel Blob → on miss, fetches from a CTAN mirror → writes to Blob → returns the file with aggressive cache headers. Each call moves a file measured in kilobytes and finishes in well under a second. This stays comfortably inside every Vercel limit because it's *file delivery*, not compilation.

**Tier 3 — Graceful degradation.**
If a package can't be resolved, don't fail silently. Surface `Package "xyz" is not available in the browser bundle` in the error panel with a link to the issue tracker.

Persist Tiers 1 and 2 into the browser's **Cache API or IndexedDB** on first fetch, so a returning user's second session never touches the network.

### Two-tier preview strategy

Real PDF compilation takes ~300–800ms. That is too slow to feel "live" while typing. So run **two rendering paths at different cadences:**

| Tier | Trigger | Renderer | Latency | Purpose |
| --- | --- | --- | --- | --- |
| **A — Draft** | 150ms debounce | KaTeX | <16ms | Instant math feedback in a lightweight structural preview. Catches typos in formulas immediately. |
| **B — PDF** | 800ms idle debounce, or ⌘S | SwiftLaTeX WASM | 300–800ms warm | The real, authoritative output. |

Tier A is a nicety, not the product — ship Tier B first and add Tier A in Phase 5 if the typing feel needs it.

## Recommended stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| **Framework** | Next.js 15 (App Router) + TypeScript | First-class Vercel deploy. App Router gives you the `/api/texlive` route handler in the same repo. |
| **Code editor** | **CodeMirror 6** | See comparison below. |
| **Syntax highlighting** | `@codemirror/legacy-modes/mode/stex` or `codemirror-lang-latex` | The legacy `stex` mode is battle-tested and ~8 KB. Start there. |
| **LaTeX compilation** | **SwiftLaTeX** (`XeTeXEngine`) in a Web Worker | Tectonic-derived, UTF-8 and OpenType native, browser-ready today. |
| **Math preview (Tier A)** | **KaTeX** | See comparison below. |
| **PDF rendering** | `pdfjs-dist` | Direct use, not `react-pdf` — you need low-level control to preserve scroll position across recompiles. |
| **State** | **Zustand** | ~1 KB, no provider tree, and the worker-message → store-update flow is clean. Redux is overkill here. |
| **Split pane** | `react-resizable-panels` | Handles keyboard accessibility and persisted sizes; don't hand-roll this. |
| **Styling** | Tailwind CSS | |
| **ZIP export** | `client-zip` | Streaming, ~3 KB, no JSZip bloat. |
| **Persistence** | IndexedDB via `idb` | Autosave. `localStorage` will hit its 5 MB ceiling on real documents. |
| **Testing** | Vitest + Playwright | Playwright matters here — WASM compilation can only really be tested in a browser. |

### Monaco vs. CodeMirror 6 → **CodeMirror 6**

| | Monaco | CodeMirror 6 |
| --- | --- | --- |
| Bundle size | ~2–5 MB | ~200–400 KB |
| Mobile/touch | Poor | Good |
| Extension model | Heavier, VS Code-shaped | Compositional, fits custom LaTeX linting well |
| Best for | IDE parity, IntelliSense | Focused editors like this one |

You're already shipping a 10–20 MB WASM engine. Do not also ship a 5 MB editor. **Choose CodeMirror 6.** Choose Monaco only if you later decide LaTeX autocomplete with rich hover documentation is a headline feature.

### KaTeX vs. MathJax → **KaTeX**

| | KaTeX | MathJax 3 |
| --- | --- | --- |
| Rendering | Synchronous, no reflow | Async, causes layout shift |
| Speed | ~10× faster | Slower |
| LaTeX coverage | Common math subset | Near-complete, custom macros |
| Bundle | ~280 KB + fonts | ~1 MB+ |

**KaTeX**, because Tier A only needs to be fast and approximately right — the WASM engine is the source of truth for correctness. If a formula renders oddly in the draft pane, the PDF pane resolves it a second later.

---

# Minimum Viable Product (MVP) Features

Ruthlessly scoped. Everything below is *must-ship*; anything not listed is Phase 6+.

### P0 — Ship-blocking

- [ ] Split-pane layout, draggable divider, persisted split ratio
- [ ] CodeMirror 6 editor with LaTeX syntax highlighting
- [ ] Debounced compilation in a Web Worker (SwiftLaTeX)
- [ ] PDF preview via pdf.js, with **scroll position preserved across recompiles**
- [ ] Download `.tex`
- [ ] Download `.pdf`
- [ ] Compilation error panel with parsed line numbers
- [ ] Autosave to IndexedDB, restore on reload
- [ ] A default starter document so the editor is never blank on first load
- [ ] Deployed on Vercel with a custom domain

### P1 — Strongly desired for launch

- [ ] Loading/progress state for the initial WASM engine download (this is a ~10s first-load; it needs a real progress bar, not a spinner)
- [ ] Manual compile button + ⌘/Ctrl+S shortcut
- [ ] Package auto-fetch working for the pre-baked Tier 1 set
- [ ] Template picker (article, beamer, IEEE conference, résumé)
- [ ] Dark mode
- [ ] Mobile: stacked tab layout instead of side-by-side

### P2 — Nice to have

- [ ] KaTeX draft preview (Tier A)
- [ ] `.zip` export (source + assets + PDF)
- [ ] Image upload into the virtual FS
- [ ] Multi-file projects
- [ ] Share-by-URL (LZ-compressed source in the fragment)

### Explicitly deferred

Collaboration, accounts, Git integration, SyncTeX click-to-source, Biber bibliographies, `.docx` export.

---

# Step-by-Step Implementation Plan

Estimates assume part-time work. Adjust to your own pace.

## Phase 1 — Setup & scaffolding (~4–6 hours)

1. **Initialize.**
   ```bash
   npx create-next-app@latest texpane --typescript --tailwind --app --eslint
   cd texpane
   npm i zustand react-resizable-panels pdfjs-dist idb client-zip
   npm i @codemirror/state @codemirror/view @codemirror/commands \
         @codemirror/language @codemirror/legacy-modes @codemirror/theme-one-dark
   npm i -D vitest @playwright/test
   ```

2. **Vendor the SwiftLaTeX engine.** Download the latest release and place `swiftlatexxetex.js` + `swiftlatexxetex.wasm` in `public/swiftlatex/`. **Serve these as static assets — do not import them through webpack.** Bundling multi-megabyte WASM through the Next.js build is slow and fragile; fetching from `/public` on the CDN is simpler and faster.

3. **Configure headers.** `next.config.ts`:
   ```ts
   const nextConfig = {
     async headers() {
       return [
         {
           // Cross-origin isolation — required if the engine uses SharedArrayBuffer.
           // WARNING: COEP will block third-party embeds (analytics, external images).
           source: "/(.*)",
           headers: [
             { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
             { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
           ],
         },
         {
           source: "/swiftlatex/:path*",
           headers: [
             { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
           ],
         },
       ];
     },
   };
   export default nextConfig;
   ```
   Verify empirically whether COOP/COEP is actually needed — if the engine works without it, drop it, because COEP creates real downstream pain.

4. **Project structure.**
   ```
   app/
     page.tsx
     api/texlive/[...path]/route.ts
   components/
     Editor.tsx  PdfPreview.tsx  Toolbar.tsx  ErrorPanel.tsx  SplitLayout.tsx
   lib/
     compiler/
       worker.ts          # Web Worker entry
       engine.ts          # SwiftLaTeX wrapper
       types.ts           # CompileRequest / CompileResult
     store/editorStore.ts
     export/{tex,pdf,zip}.ts
     parseTexLog.ts
   scripts/build-texlive-cache.ts
   public/swiftlatex/  public/texlive-cache/
   ```

## Phase 2 — UI shell (~6–8 hours)

5. **Split layout.**
   ```tsx
   <PanelGroup direction="horizontal" autoSaveId="texpane-split">
     <Panel defaultSize={50} minSize={20}><Editor /></Panel>
     <PanelResizeHandle className="w-1 bg-neutral-700 hover:bg-blue-500 transition-colors" />
     <Panel defaultSize={50} minSize={20}><PdfPreview /></Panel>
   </PanelGroup>
   ```

6. **CodeMirror editor.** Mount imperatively in a `useEffect`; do not re-create the `EditorView` on every render. Wire `EditorView.updateListener` to push document changes into Zustand.
   ```ts
   import { StreamLanguage } from "@codemirror/language";
   import { stex } from "@codemirror/legacy-modes/mode/stex";
   // extensions: [StreamLanguage.define(stex), oneDark, keymap.of(defaultKeymap), ...]
   ```

7. **Toolbar and error panel** as static shells. Fill them in later.

## Phase 3 — State management (~3–4 hours)

8. **Zustand store.** Model compilation as an explicit state machine — this is what prevents the race conditions that plague live-preview editors.
   ```ts
   type CompileStatus = "idle" | "loading-engine" | "compiling" | "success" | "error";

   interface EditorState {
     source: string;
     pdfData: Uint8Array | null;
     status: CompileStatus;
     log: string;
     errors: TexError[];
     compileId: number;          // monotonic — discard results from stale compiles
     setSource: (s: string) => void;
     requestCompile: () => void;
   }
   ```
   The `compileId` guard is non-negotiable: if a user types during a compile, the in-flight result is stale and must be dropped, or the preview will flicker backwards.

9. **Debounce.** 800ms of typing inactivity. Reset the timer on every keystroke. If a compile is already running when a new request arrives, mark it superseded rather than queueing — you only ever care about the latest source.

10. **Autosave.** Write `source` to IndexedDB on a separate 2s debounce. Restore on mount.

## Phase 4 — Compilation pipeline (~12–16 hours — the hard part)

11. **Worker wrapper.**
    ```ts
    // lib/compiler/worker.ts
    importScripts("/swiftlatex/swiftlatexxetex.js");

    let engine: any = null;

    self.onmessage = async (e: MessageEvent<CompileRequest>) => {
      const { id, source } = e.data;
      try {
        if (!engine) {
          engine = new XeTeXEngine();
          await engine.loadEngine();
          engine.setTexliveEndpoint(self.location.origin + "/api/texlive/");
        }
        engine.writeMemFSFile("main.tex", source);
        engine.setEngineMainFile("main.tex");
        const result = await engine.compileLaTeX();

        if (result.status === 0) {
          // Transfer the buffer rather than copying it — PDFs get large.
          self.postMessage({ id, ok: true, pdf: result.pdf, log: result.log },
                           [result.pdf.buffer]);
        } else {
          self.postMessage({ id, ok: false, log: result.log });
        }
      } catch (err) {
        self.postMessage({ id, ok: false, log: String(err) });
      }
    };
    ```

12. **Engine lifecycle.** Load the engine once and keep it warm — `loadEngine()` is the expensive call. Start it on app mount, in parallel with rendering the UI, so the 10s download overlaps with the user reading the starter document.

13. **Watchdog timer.** A malformed macro (`\def\x{\x}\x`) will spin the worker forever. Wrap every compile in a 30s timeout on the main thread; on expiry, `worker.terminate()`, spawn a fresh worker, and report a timeout error. **Do not skip this** — without it a single bad document hangs the tab permanently.

14. **The TeX Live proxy route.**
    ```ts
    // app/api/texlive/[...path]/route.ts
    import { put, head } from "@vercel/blob";

    export const runtime = "nodejs";
    export const maxDuration = 15;

    export async function GET(
      req: Request,
      { params }: { params: Promise<{ path: string[] }> }
    ) {
      const { path } = await params;
      const key = `texlive/${path.join("/")}`;

      // 1. Blob cache hit?
      // 2. Miss → fetch from CTAN mirror, put() into Blob, return.
      // 3. Not found → 404 with a machine-readable body the worker can surface.
      //
      // Always return: Cache-Control: public, max-age=31536000, immutable
    }
    ```
    Sanitize `path` aggressively — this route takes user-influenced input and turns it into an outbound fetch. Allowlist the filename pattern (`/^[\w.\-/]+$/`), reject anything containing `..`, and pin the upstream host.

15. **Build the Tier 1 cache.** `scripts/build-texlive-cache.ts` runs at build time, pulls the common-package closure, and writes to `public/texlive-cache/`. Commit the manifest; consider committing the files themselves if total size stays under ~30 MB.

16. **PDF rendering.**
    ```ts
    const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    // Render page-by-page to canvas.
    // CRITICAL: capture scrollTop before re-render, restore after.
    // Without this, every keystroke-triggered recompile yanks the user back to page 1.
    ```

17. **Log parsing.** `lib/parseTexLog.ts` — extract `! LaTeX Error:` blocks and `l.<N>` line markers into structured `TexError[]`. Feed them into CodeMirror's lint gutter so errors appear inline next to the offending line, not only in a panel below.

## Phase 5 — Export (~4–5 hours)

18. **`.tex` export.**
    ```ts
    const blob = new Blob([source], { type: "application/x-tex" });
    // createObjectURL → anchor.download → click → revokeObjectURL
    ```
    Always `revokeObjectURL` — leaked object URLs pin the entire buffer in memory.

19. **`.pdf` export.** The `Uint8Array` is already in the store. Same download helper. Guard the button on `status === "success"`; exporting a stale PDF after a failed recompile is a real and confusing bug.

20. **`.zip` export (P2).** `client-zip` streaming `main.tex` + assets + `output.pdf`.

21. **Filename derivation.** Parse `\title{...}` and slugify it. `Untitled.pdf` is a poor default when a user downloads six documents in a session.

## Phase 6 — Polish & harden (~8–10 hours)

22. Engine-download progress bar with real byte counts.
23. Template picker.
24. KaTeX draft tier.
25. Playwright E2E: load → type → compile → assert PDF renders → download.
26. Error boundaries around the PDF pane so a render failure doesn't white-screen the editor.
27. Lighthouse pass; lazy-load `pdfjs-dist` and KaTeX.

---

# Vercel Deployment Guide

## Initial deploy

```bash
git init && git add -A && git commit -m "initial"
gh repo create texpane --private --source=. --push
npx vercel        # link + preview deploy
npx vercel --prod
```

Or import the repo through the Vercel dashboard. Framework preset auto-detects as Next.js; leave build settings at defaults.

## `vercel.json`

Most configuration belongs in `next.config.ts` (headers) rather than here. Use `vercel.json` for function-level tuning:

```json
{
  "functions": {
    "app/api/texlive/[...path]/route.ts": {
      "maxDuration": 15,
      "memory": 1024
    }
  }
}
```

15 seconds is generous for what is effectively a caching file proxy. Setting a *low* ceiling is deliberate: it caps the blast radius if the upstream mirror hangs.

## WASM MIME type

Vercel serves `/public` assets with correct MIME types, but verify:

```bash
curl -I https://your-app.vercel.app/swiftlatex/swiftlatexxetex.wasm | grep -i content-type
# expect: application/wasm
```

If it comes back as `application/octet-stream`, `WebAssembly.instantiateStreaming` will fail. Add an explicit header rule in `next.config.ts`.

## Vercel Blob

```bash
npx vercel blob store add texlive-cache
```

This injects `BLOB_READ_WRITE_TOKEN` into the environment automatically. Pull it locally with `vercel env pull .env.local`.

## Environment variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | All | Auto-injected by Blob |
| `TEXLIVE_UPSTREAM_URL` | All | Pinned CTAN mirror |
| `NEXT_PUBLIC_ENGINE_PATH` | All | `/swiftlatex/` — lets you swap to an external CDN later |

## Deployment checklist

- [ ] `Content-Type: application/wasm` confirmed in production
- [ ] Engine assets returning `Cache-Control: immutable`
- [ ] COOP/COEP headers present *and* verified as actually necessary
- [ ] `/api/texlive/` returns 200 for a known package and a clean 404 for garbage input
- [ ] Path traversal attempt (`/api/texlive/../../etc/passwd`) returns 400
- [ ] Cold-load timed on a throttled connection (Fast 3G) — if it exceeds ~30s, the engine needs splitting or better progressive loading
- [ ] Tested on Safari (the strictest WASM memory environment)

## Cost profile

Because compilation runs client-side, production traffic generates almost no function invocations — only Tier 2 package cache misses, which converge toward zero as the Blob cache warms. Static asset bandwidth for the engine is the main line item, and Vercel's CDN caching plus the browser Cache API keeps repeat visits at near zero. **This project should sit inside the Hobby tier essentially indefinitely.**

---

# Potential Challenges & Edge Cases

## Critical — plan for these up front

**1. The first-load cliff.**
The WASM engine is roughly 10–20 MB. On a slow connection that's 20–40 seconds of dead air. Mitigations: start `loadEngine()` immediately on mount so it overlaps with the user reading the starter document; show a real progress bar with byte counts; register a Service Worker so the second visit is instant; consider a static pre-rendered PDF of the starter document displayed while the engine loads, so the right pane is never empty.

**2. Infinite loops in TeX.**
TeX is Turing-complete. `\def\x{\x}\x` hangs the worker forever. The 30s watchdog + `terminate()` + fresh-worker respawn (Phase 4, step 13) is mandatory, not optional.

**3. Safari's WASM memory ceiling.**
iOS Safari has historically capped per-tab memory far below desktop browsers, and Emscripten heaps hit that wall on large documents. Test on a real device early. Have a fallback message rather than a silent crash.

**4. Missing packages in the long tail.**
Someone will `\usepackage{pgfplots}` on day one. TikZ/PGF support in browser TeX engines has historically been incomplete. Be honest in the UI about what's supported, ship a "request a package" link, and treat the Tier 1 pre-baked set as a living list driven by real error telemetry.

**5. Multi-pass compilation.**
`\tableofcontents`, `\ref`, and `\cite` require two or three passes. A single `compileLaTeX()` call produces a document with `??` where references should be. Detect `Rerun to get cross-references right` in the log and automatically re-run, capping at three passes. This roughly triples compile time for affected documents — surface it as "Resolving references… (pass 2/3)".

**6. Bibliographies.**
BibTeX and especially Biber are separate binaries and are largely not available in the WASM engine. Options, in increasing order of effort: document the limitation and support only manual `thebibliography` environments (v1); ship a JS BibTeX reimplementation; or add a dedicated serverless route for the bib pass alone, which *does* fit in 250 MB because Biber is small. **Recommend deferring entirely and documenting it clearly** — half-working citations are worse than no citations.

## Moderate

**7. Debounce tuning.** 800ms is a starting guess. Too short and you compile constantly on a slow machine; too long and it stops feeling live. Consider adapting the interval to observed compile duration.

**8. Scroll position on recompile.** Covered above, but worth restating: getting this wrong makes the editor feel broken even when everything else works.

**9. COEP breaking third-party embeds.** If cross-origin isolation is required, every external resource needs `crossorigin` attributes and CORP headers. Analytics scripts, Google Fonts, and remote images all break. Test whether the engine actually needs `SharedArrayBuffer` before accepting this cost.

**10. Large PDF memory pressure.** A 200-page document with figures can produce a PDF of tens of megabytes, held simultaneously in the worker, the transfer, the store, and pdf.js. Transfer buffers rather than copying them, and release previous PDF data before assigning new.

**11. Unsaved-work loss.** IndexedDB autosave plus a `beforeunload` guard when there are uncommitted changes.

**12. Paste of enormous documents.** A 5,000-line thesis pasted at once triggers immediate compilation of something that takes 10+ seconds. Detect large paste events and prompt before compiling rather than freezing.

## Lower priority but worth noting

**13. Path traversal in `/api/texlive`.** Addressed in Phase 4, but it's the one genuine security surface in the whole application — it takes user-influenced input and makes an outbound request. Allowlist, don't blocklist.

**14. CTAN rate limiting.** Aggressive Tier 2 fetching from a single mirror could get the deployment throttled. Pin a mirror, cache permanently in Blob, and consider a modest per-IP rate limit on the route.

**15. Font licensing.** Redistributing TeX fonts through your CDN is generally fine (most are OFL/LPPL) but confirm before bundling anything unusual.

**16. Non-deterministic PDFs.** PDFs embed timestamps, so byte-comparison tests will fail spuriously. Test by rendering page one to a canvas and comparing pixels with a tolerance, not by hashing the file.

---

## Suggested build order, condensed

```
Week 1   Phases 1–2      Scaffold + UI shell.        Milestone: draggable panes, editor highlights LaTeX.
Week 2   Phase 3 + 4a    State + worker + engine.    Milestone: hardcoded document compiles to PDF bytes in console.
Week 3   Phase 4b        pdf.js + package proxy.     Milestone: type → see PDF update. This is the "it works" moment.
Week 4   Phase 5         Export + error handling.    Milestone: full MVP loop, deployed to Vercel.
Week 5   Phase 6         Polish, tests, hardening.   Milestone: shareable.
```

**Get to the Week 3 milestone as fast as possible.** Everything before it is scaffolding you already know how to build; everything genuinely uncertain about this project lives in the compilation pipeline. Prove the WASM engine compiles a real document end-to-end before investing in UI polish — if SwiftLaTeX turns out not to handle your target document class, you want to know that in week two, not week five.
