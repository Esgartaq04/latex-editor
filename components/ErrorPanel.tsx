"use client";

import { useState } from "react";
import { useEditorStore } from "@/lib/store/editorStore";

/**
 * The parsed diagnostics come first and the raw log is collapsed behind a
 * toggle. Dumping the full pdftex log at someone is the failure mode this
 * panel exists to avoid, but the log still has to be reachable — for the
 * long tail of errors the parser does not recognise, it is the only clue.
 */
export function ErrorPanel({ onGoToLine }: { onGoToLine?: (line: number) => void }) {
  const errors = useEditorStore((s) => s.errors);
  const log = useEditorStore((s) => s.log);
  const status = useEditorStore((s) => s.status);
  const [showLog, setShowLog] = useState(false);

  const hardErrors = errors.filter((e) => e.severity === "error");
  const warnings = errors.filter((e) => e.severity === "warning");
  const collapsed = status === "success" && errors.length === 0;

  if (collapsed) return null;

  return (
    <div
      className="flex max-h-64 flex-col border-t text-sm"
      style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
      data-testid="error-panel"
    >
      <div
        className="flex items-center gap-3 border-b px-3 py-1.5 text-xs"
        style={{ borderColor: "var(--line)" }}
      >
        <span style={{ color: hardErrors.length ? "var(--danger)" : "var(--ink-dim)" }}>
          {hardErrors.length} error{hardErrors.length === 1 ? "" : "s"}
        </span>
        <span style={{ color: warnings.length ? "var(--warn)" : "var(--ink-dim)" }}>
          {warnings.length} warning{warnings.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 hover:opacity-70"
          style={{ border: "1px solid var(--line)", color: "var(--ink-dim)" }}
          onClick={() => setShowLog((v) => !v)}
        >
          {showLog ? "Hide raw log" : "Raw log"}
        </button>
      </div>

      <div className="overflow-auto">
        {showLog ? (
          <pre
            className="whitespace-pre-wrap px-3 py-2 font-mono text-xs"
            style={{ color: "var(--ink-dim)" }}
          >
            {log || "No log output."}
          </pre>
        ) : (
          <ul>
            {errors.length === 0 && (
              <li className="px-3 py-2 text-xs" style={{ color: "var(--ink-dim)" }}>
                No diagnostics were parsed from the log.
              </li>
            )}
            {errors.map((error, index) => (
              <li
                key={`${error.severity}-${error.line}-${index}`}
                className="border-b px-3 py-2 last:border-b-0"
                style={{ borderColor: "var(--line)" }}
              >
                <div className="flex gap-2">
                  <span
                    className="shrink-0 font-mono text-xs"
                    style={{
                      color: error.severity === "error" ? "var(--danger)" : "var(--warn)",
                    }}
                  >
                    {error.severity === "error" ? "error" : "warn"}
                  </span>
                  {error.line !== null && (
                    <button
                      type="button"
                      className="shrink-0 font-mono text-xs underline underline-offset-2 hover:opacity-70"
                      style={{ color: "var(--accent)" }}
                      onClick={() => onGoToLine?.(error.line as number)}
                    >
                      line {error.line}
                    </button>
                  )}
                  <span className="min-w-0 break-words">{error.message}</span>
                </div>
                {error.detail && (
                  <pre
                    className="mt-1 overflow-x-auto whitespace-pre font-mono text-xs"
                    style={{ color: "var(--ink-dim)" }}
                  >
                    {error.detail}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
