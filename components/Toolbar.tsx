"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/lib/store/editorStore";
import { deriveBasename, downloadPdf, downloadTex, downloadZip } from "@/lib/export/download";
import { templates } from "@/lib/templates";

const buttonStyle = {
  border: "1px solid var(--line)",
  background: "var(--surface)",
} as const;

export function Toolbar({
  theme,
  onToggleTheme,
}: {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}) {
  const source = useEditorStore((s) => s.source);
  const pdf = useEditorStore((s) => s.pdf);
  const status = useEditorStore((s) => s.status);
  const autoCompile = useEditorStore((s) => s.autoCompile);
  const requestCompile = useEditorStore((s) => s.requestCompile);
  const setAutoCompile = useEditorStore((s) => s.setAutoCompile);
  const replaceSource = useEditorStore((s) => s.replaceSource);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // ⌘S / Ctrl+S anywhere in the app, not only when the editor has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        requestCompile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestCompile]);

  const basename = deriveBasename(source);
  // Exporting the PDF from the previous successful compile after a failed one
  // hands the user a file that does not match what is on screen.
  const pdfReady = pdf !== null && status === "success";

  return (
    <header
      className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
      style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
    >
      <span className="mr-1 font-semibold tracking-tight">TeXPane</span>

      <button
        type="button"
        onClick={requestCompile}
        disabled={status === "compiling"}
        className="rounded px-2.5 py-1 text-sm disabled:opacity-50"
        style={{ ...buttonStyle, borderColor: "var(--accent)", color: "var(--accent)" }}
        data-testid="compile"
      >
        {status === "compiling" ? "Compiling…" : "Compile"}
        <kbd className="ml-1.5 text-xs opacity-60">⌘S</kbd>
      </button>

      <label
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm"
        style={buttonStyle}
      >
        <input
          type="checkbox"
          checked={autoCompile}
          onChange={(event) => setAutoCompile(event.target.checked)}
        />
        Auto
      </label>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded px-2.5 py-1 text-sm"
          style={buttonStyle}
        >
          Templates ▾
        </button>
        {menuOpen && (
          <div
            className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded shadow-lg"
            style={{ border: "1px solid var(--line)", background: "var(--surface-raised)" }}
          >
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:opacity-80"
                onClick={() => {
                  const replace =
                    !useEditorStore.getState().dirty ||
                    window.confirm("Replace the current document with this template?");
                  if (replace) replaceSource(template.source);
                  setMenuOpen(false);
                }}
              >
                <span className="block">{template.name}</span>
                <span className="block text-xs" style={{ color: "var(--ink-dim)" }}>
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => downloadTex(source, basename)}
          className="rounded px-2.5 py-1 text-sm"
          style={buttonStyle}
          data-testid="download-tex"
        >
          .tex
        </button>
        <button
          type="button"
          onClick={() => pdf && downloadPdf(pdf, basename)}
          disabled={!pdfReady}
          className="rounded px-2.5 py-1 text-sm disabled:opacity-40"
          style={buttonStyle}
          data-testid="download-pdf"
          title={pdfReady ? undefined : "Compile successfully before downloading a PDF"}
        >
          .pdf
        </button>
        <button
          type="button"
          onClick={() => void downloadZip(source, pdfReady ? pdf : null, basename)}
          className="rounded px-2.5 py-1 text-sm"
          style={buttonStyle}
        >
          .zip
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded px-2.5 py-1 text-sm"
          style={buttonStyle}
          aria-label="Toggle colour theme"
        >
          {theme === "dark" ? "☾" : "☀"}
        </button>
      </div>
    </header>
  );
}
