/** Shared message contract between the main thread and the compile worker. */

export interface CompileRequest {
  /** Monotonic id used to discard results from superseded compiles. */
  id: number;
  /** Contents of `main.tex`. */
  source: string;
  /** Extra files to place in the virtual filesystem alongside `main.tex`. */
  assets?: { name: string; data: Uint8Array }[];
  /**
   * Maximum number of pdftex passes. `\tableofcontents`, `\ref` and `\cite`
   * need two or three; anything above that is a document that will never
   * converge.
   */
  maxPasses?: number;
}

export interface TexError {
  /** 1-based line in `main.tex`, when the log gives one. */
  line: number | null;
  message: string;
  /** Raw log context, shown on demand. */
  detail?: string;
  severity: "error" | "warning";
}

export type WorkerOutbound =
  | { type: "engine-progress"; loaded: number; total: number }
  | { type: "engine-ready" }
  | { type: "engine-failed"; message: string }
  | { type: "pass"; id: number; pass: number; of: number }
  | { type: "result"; id: number; ok: true; pdf: ArrayBuffer; log: string; passes: number }
  | { type: "result"; id: number; ok: false; log: string; passes: number };

export type WorkerInbound =
  | { type: "init"; texliveEndpoint: string; enginePath: string }
  | ({ type: "compile" } & CompileRequest);

export type CompileStatus =
  | "idle"
  | "loading-engine"
  | "compiling"
  | "success"
  | "error";
