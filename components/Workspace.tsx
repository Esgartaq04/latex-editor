"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./Editor";
import { PdfPreview } from "./PdfPreview";
import { Toolbar } from "./Toolbar";
import { ErrorPanel } from "./ErrorPanel";
import { StatusBar } from "./StatusBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { disposeEngine, useEditorStore } from "@/lib/store/editorStore";

type Theme = "dark" | "light";
type MobileTab = "source" | "preview";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(
      document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    );
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      if (next === "light") document.documentElement.setAttribute("data-theme", "light");
      else document.documentElement.removeAttribute("data-theme");
      try {
        localStorage.setItem("texpane-theme", next);
      } catch {
        /* storage may be blocked; the theme still applies for this session */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

/** Side-by-side needs width; below this the panes stack behind tabs. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function Workspace() {
  const [theme, toggleTheme] = useTheme();
  const narrow = useIsNarrow();
  const [tab, setTab] = useState<MobileTab>("source");

  const init = useEditorStore((s) => s.init);
  const dirty = useEditorStore((s) => s.dirty);
  const status = useEditorStore((s) => s.status);

  useEffect(() => {
    void init();
    return () => disposeEngine();
  }, [init]);

  // Autosave is debounced by two seconds, so a fast close can still outrun it.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Jumping to a line from the error panel switches back to the source on mobile.
  const goToLine = useCallback(
    (line: number) => {
      if (narrow) setTab("source");
      window.dispatchEvent(new CustomEvent("texpane:goto-line", { detail: line }));
    },
    [narrow],
  );

  const editorPane = (
    <ErrorBoundary label="The editor">
      <Editor theme={theme} />
    </ErrorBoundary>
  );

  const previewPane = (
    <ErrorBoundary label="The preview">
      <PdfPreview />
    </ErrorBoundary>
  );

  return (
    <div className="flex h-dvh flex-col">
      <Toolbar theme={theme} onToggleTheme={toggleTheme} />

      {narrow ? (
        <>
          <div
            className="flex border-b text-sm"
            style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
          >
            {(["source", "preview"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className="flex-1 px-3 py-2 capitalize"
                style={{
                  color: tab === value ? "var(--accent)" : "var(--ink-dim)",
                  borderBottom:
                    tab === value ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                {value}
                {value === "preview" && status === "compiling" ? " …" : ""}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">{tab === "source" ? editorPane : previewPane}</div>
        </>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId="texpane-split" className="min-h-0 flex-1">
          <Panel defaultSize={50} minSize={20}>
            {editorPane}
          </Panel>
          <PanelResizeHandle
            className="w-1 transition-colors"
            style={{ background: "var(--line)" }}
          />
          <Panel defaultSize={50} minSize={20}>
            {previewPane}
          </Panel>
        </PanelGroup>
      )}

      <ErrorPanel onGoToLine={goToLine} />
      <StatusBar />
    </div>
  );
}
