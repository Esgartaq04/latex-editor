"use client";

import { useEditorStore } from "@/lib/store/editorStore";
import { summarise } from "@/lib/parseTexLog";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The first visit downloads a WebAssembly TeX engine. That is a real wait, so
 * it gets real numbers — a spinner with no byte count reads as a hang.
 */
export function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.engineProgress);
  const pass = useEditorStore((s) => s.pass);
  const errors = useEditorStore((s) => s.errors);
  const lastCompileMs = useEditorStore((s) => s.lastCompileMs);
  const dirty = useEditorStore((s) => s.dirty);
  const notice = useEditorStore((s) => s.autoCompileDisabledReason);

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;

  let message: string;
  if (status === "loading-engine" && progress) {
    message =
      percent !== null
        ? `Downloading the TeX engine — ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)} (${percent}%)`
        : `Downloading the TeX engine — ${formatBytes(progress.loaded)}`;
  } else if (status === "loading-engine") {
    message = "Starting the TeX engine…";
  } else if (status === "compiling" && pass && pass.current > 1) {
    message = `Resolving references… (pass ${pass.current} of ${pass.of})`;
  } else if (status === "compiling") {
    message = "Compiling…";
  } else if (status === "error") {
    message = summarise(errors) ?? "Compilation failed.";
  } else if (status === "success") {
    const summary = summarise(errors.filter((e) => e.severity === "warning"));
    message = summary
      ? `Compiled with warnings — ${summary}`
      : `Compiled${lastCompileMs !== null ? ` in ${lastCompileMs} ms` : ""}.`;
  } else {
    message = "Ready.";
  }

  return (
    <div
      className="relative flex items-center gap-3 border-t px-3 py-1 text-xs"
      style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
      data-testid="status"
    >
      {percent !== null && status === "loading-engine" && (
        <span
          className="absolute inset-y-0 left-0 -z-0 transition-[width] duration-150"
          style={{ width: `${percent}%`, background: "color-mix(in srgb, var(--accent) 20%, transparent)" }}
          aria-hidden
        />
      )}
      <span
        className="z-10 truncate"
        style={{ color: status === "error" ? "var(--danger)" : "var(--ink-dim)" }}
      >
        {message}
      </span>
      {notice && (
        <span className="z-10 truncate" style={{ color: "var(--warn)" }}>
          {notice}
        </span>
      )}
      <span className="z-10 ml-auto shrink-0" style={{ color: "var(--ink-dim)" }}>
        {dirty ? "Unsaved changes" : "Saved"}
      </span>
    </div>
  );
}
