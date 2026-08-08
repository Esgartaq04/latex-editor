import { create } from "zustand";
import { TexEngine } from "@/lib/compiler/engine";
import type { CompileStatus, TexError } from "@/lib/compiler/types";
import { parseTexLog } from "@/lib/parseTexLog";
import { loadDocument, saveDocument } from "@/lib/persistence";
import { DEFAULT_SOURCE } from "@/lib/templates";

const COMPILE_DEBOUNCE_MS = 800;
const AUTOSAVE_DEBOUNCE_MS = 2_000;

/**
 * Above this, a keystroke-triggered rebuild is slow enough to be worse than
 * useless, so auto-compile switches itself off and the user drives with ⌘S.
 */
const LARGE_DOCUMENT_LINES = 1_500;

export interface EditorState {
  source: string;
  pdf: Uint8Array | null;
  status: CompileStatus;
  log: string;
  errors: TexError[];
  /** Monotonic; results from anything below `compileId` are stale and dropped. */
  compileId: number;
  pass: { current: number; of: number } | null;
  engineProgress: { loaded: number; total: number } | null;
  engineError: string | null;
  autoCompile: boolean;
  autoCompileDisabledReason: string | null;
  dirty: boolean;
  restored: boolean;
  lastCompileMs: number | null;

  init: () => Promise<void>;
  setSource: (source: string) => void;
  replaceSource: (source: string) => void;
  requestCompile: () => void;
  setAutoCompile: (enabled: boolean) => void;
}

let engine: TexEngine | null = null;
let compileTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let queued = false;

export const useEditorStore = create<EditorState>((set, get) => {
  function getEngine(): TexEngine {
    if (!engine) {
      engine = new TexEngine({
        onProgress: (loaded, total) => set({ engineProgress: { loaded, total } }),
        onPass: (current, of) => set({ pass: { current, of } }),
      });
    }
    return engine;
  }

  async function runCompile() {
    if (running) {
      // Only the newest source matters, so note that another run is wanted and
      // let the current one finish rather than building a queue of stale work.
      queued = true;
      return;
    }
    running = true;

    const id = get().compileId + 1;
    set({
      compileId: id,
      status: get().pdf ? "compiling" : "loading-engine",
      pass: null,
    });

    const startedAt = performance.now();
    const source = get().source;

    try {
      const outcome = await getEngine().compile({ id, source });

      // A newer compile started while this one ran; its result wins.
      if (get().compileId !== id) return;

      const errors = parseTexLog(outcome.log);
      set({
        pdf: outcome.ok && outcome.pdf ? outcome.pdf : get().pdf,
        status: outcome.ok ? "success" : "error",
        log: outcome.log,
        errors,
        pass: null,
        lastCompileMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      if (get().compileId !== id) return;
      const message = err instanceof Error ? err.message : String(err);
      set({
        status: "error",
        log: message,
        errors: [{ line: null, message, severity: "error" }],
        engineError: message,
        pass: null,
      });
    } finally {
      running = false;
      set({ engineProgress: null });
      if (queued) {
        queued = false;
        void runCompile();
      }
    }
  }

  function scheduleCompile() {
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = setTimeout(() => void runCompile(), COMPILE_DEBOUNCE_MS);
  }

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      void saveDocument(get().source);
      set({ dirty: false });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  return {
    source: DEFAULT_SOURCE,
    pdf: null,
    status: "idle",
    log: "",
    errors: [],
    compileId: 0,
    pass: null,
    engineProgress: null,
    engineError: null,
    autoCompile: true,
    autoCompileDisabledReason: null,
    dirty: false,
    restored: false,
    lastCompileMs: null,

    async init() {
      if (get().restored) return;
      const saved = await loadDocument();
      if (saved?.source) set({ source: saved.source });
      set({ restored: true });
      applyDocumentSizePolicy(get().source, set);
      void runCompile();
    },

    setSource(source) {
      set({ source, dirty: true });
      scheduleAutosave();
      applyDocumentSizePolicy(source, set);
      if (get().autoCompile) scheduleCompile();
    },

    /** Wholesale replacement (template picker, restore) — compile immediately. */
    replaceSource(source) {
      set({ source, dirty: true, errors: [], log: "" });
      scheduleAutosave();
      applyDocumentSizePolicy(source, set);
      if (compileTimer) clearTimeout(compileTimer);
      void runCompile();
    },

    requestCompile() {
      if (compileTimer) clearTimeout(compileTimer);
      void saveDocument(get().source);
      set({ dirty: false });
      void runCompile();
    },

    setAutoCompile(enabled) {
      set({ autoCompile: enabled, autoCompileDisabledReason: null });
      if (enabled) scheduleCompile();
      else if (compileTimer) clearTimeout(compileTimer);
    },
  };
});

function applyDocumentSizePolicy(
  source: string,
  set: (partial: Partial<EditorState>) => void,
) {
  const state = useEditorStore.getState?.();
  if (!state || !state.autoCompile) return;
  const lines = countLines(source);
  if (lines > LARGE_DOCUMENT_LINES) {
    set({
      autoCompile: false,
      autoCompileDisabledReason: `Auto-compile paused: ${lines.toLocaleString()} lines is large enough that rebuilding on every pause would be slower than helpful. Use Compile (⌘S) when you are ready.`,
    });
  }
}

function countLines(source: string): number {
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

export function disposeEngine() {
  engine?.dispose();
  engine = null;
}
