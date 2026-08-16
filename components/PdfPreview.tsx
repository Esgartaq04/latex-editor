"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEditorStore } from "@/lib/store/editorStore";
import { asset } from "@/lib/basePath";

/**
 * pdf.js is used directly rather than through a React wrapper because the one
 * behaviour that decides whether this feels like an editor or a toy — keeping
 * the reader's scroll position across a recompile — needs control over exactly
 * when canvases are swapped.
 */

type PdfjsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Loaded on demand: ~350 KB that the first paint does not need. */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = asset("/pdfjs/pdf.worker.min.mjs");
      return mod;
    });
  }
  return pdfjsPromise;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export function PdfPreview() {
  const pdf = useEditorStore((s) => s.pdf);
  const status = useEditorStore((s) => s.status);

  const scrollHost = useRef<HTMLDivElement | null>(null);
  const pageHost = useRef<HTMLDivElement | null>(null);
  const renderToken = useRef(0);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  const render = useCallback(async (data: Uint8Array, scale: number) => {
    const host = pageHost.current;
    const scroller = scrollHost.current;
    if (!host || !scroller) return;

    const token = ++renderToken.current;
    const previousScrollTop = scroller.scrollTop;

    try {
      const pdfjs = await loadPdfjs();
      // pdf.js takes ownership of the buffer it is given, so hand it a copy —
      // otherwise the store's copy is detached and the next download is empty.
      const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      if (token !== renderToken.current) {
        void doc.destroy();
        return;
      }

      const previousDoc = docRef.current;
      docRef.current = doc;
      setPageCount(doc.numPages);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const fragment = document.createDocumentFragment();

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        if (token !== renderToken.current) return;

        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-page";
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

        const context = canvas.getContext("2d");
        if (!context) continue;
        await page.render({ canvasContext: context, viewport }).promise;
        if (token !== renderToken.current) return;
        fragment.appendChild(canvas);
      }

      if (token !== renderToken.current) return;

      // Swap the whole page set in one go: replacing canvases individually makes
      // the pane flash white between passes.
      host.replaceChildren(fragment);
      setRenderError(null);

      // Restore the reader's position. Absolute rather than proportional —
      // an edit on page 1 should not move page 12 under the reader.
      scroller.scrollTop = Math.min(
        previousScrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );

      void previousDoc?.destroy();
    } catch (err) {
      if (token !== renderToken.current) return;
      setRenderError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!pdf) return;
    void render(pdf, zoom);
  }, [pdf, zoom, render]);

  useEffect(() => {
    return () => {
      renderToken.current++;
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, []);

  const stepZoom = (direction: 1 | -1) => {
    setZoom((current) => {
      const index = ZOOM_STEPS.indexOf(current);
      const next = index === -1 ? 2 : index + direction;
      return ZOOM_STEPS[Math.min(Math.max(next, 0), ZOOM_STEPS.length - 1)];
    });
  };

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--paper-backdrop)" }}>
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
        style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
      >
        <span style={{ color: "var(--ink-dim)" }}>
          {pageCount > 0 ? `${pageCount} page${pageCount === 1 ? "" : "s"}` : "No output yet"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => stepZoom(-1)}
            className="rounded px-2 py-0.5 hover:opacity-70"
            style={{ border: "1px solid var(--line)" }}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center tabular-nums" style={{ color: "var(--ink-dim)" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => stepZoom(1)}
            className="rounded px-2 py-0.5 hover:opacity-70"
            style={{ border: "1px solid var(--line)" }}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div ref={scrollHost} className="relative flex-1 overflow-auto p-4" data-testid="pdf-scroll">
        {renderError && (
          <p className="m-4 text-sm" style={{ color: "var(--danger)" }}>
            The PDF could not be displayed: {renderError}
          </p>
        )}
        {!pdf && !renderError && (
          <p className="m-4 text-center text-sm" style={{ color: "var(--ink-dim)" }}>
            {status === "error"
              ? "Compilation failed — see the errors below."
              : "The compiled document will appear here."}
          </p>
        )}
        <div ref={pageHost} data-testid="pdf-pages" />
      </div>
    </div>
  );
}
