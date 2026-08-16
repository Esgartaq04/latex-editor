import { BASE_PATH } from "@/lib/basePath";
import type { CompileRequest, TexError } from "./types";

/**
 * Main-thread wrapper around the SwiftLaTeX pdftex worker.
 *
 * Responsibilities that deliberately live here rather than in the worker:
 *
 *  - the watchdog, because a TeX infinite loop (`\def\x{\x}\x`) wedges the
 *    worker's event loop and only `terminate()` from outside can recover it;
 *  - multi-pass compilation, which is just "send `compilelatex` again" — the
 *    engine keeps its virtual filesystem between calls, so `.aux` survives;
 *  - the WASM prefetch, so the download has an observable byte count.
 */

const ENGINE_DIR = BASE_PATH + "/swiftlatex/";
const WORKER_URL = ENGINE_DIR + "texpane-engine.js";
const WASM_URL = ENGINE_DIR + "swiftlatexpdftex.wasm";
const TEXLIVE_DIR = BASE_PATH + "/texlive/";

/** A pass that produces no PDF at all is broken; retrying will not help. */
const DEFAULT_MAX_PASSES = 3;
const COMPILE_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;

const RERUN_PATTERNS = [
  /Rerun to get cross-references right/i,
  /Rerun to get outlines right/i,
  /Label\(s\) may have changed\. Rerun/i,
  /Please \(re\)run BibTeX/i,
  /Citation .* undefined/i,
];

export interface CompileOutcome {
  ok: boolean;
  pdf: Uint8Array | null;
  log: string;
  passes: number;
  /** Set when the watchdog fired rather than the engine returning. */
  timedOut?: boolean;
}

export interface EngineEvents {
  onProgress?: (loaded: number, total: number) => void;
  onPass?: (pass: number, of: number) => void;
}

interface PendingMessage {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TexEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending: PendingMessage | null = null;
  private wasmPrefetched = false;
  private disposed = false;

  constructor(private events: EngineEvents = {}) {}

  /**
   * Downloads the WASM binary with progress reporting and warms the worker.
   * Safe to call repeatedly; the work happens once.
   */
  load(): Promise<void> {
    if (!this.ready) this.ready = this.bootstrap();
    return this.ready;
  }

  private async bootstrap(): Promise<void> {
    await this.prefetchAssets();
    await this.spawn();
  }

  /**
   * Pull the two large assets through the HTTP cache before the worker starts:
   * the WASM binary and the format dump. Both are otherwise fetched from inside
   * the worker with no progress signal — the format dump by a *synchronous*
   * XHR, which would stall the worker silently for the largest download of the
   * whole first visit. Prefetching here means the worker's own requests are
   * cache hits, and the user sees a real byte counter.
   */
  private async prefetchAssets(): Promise<void> {
    if (this.wasmPrefetched) return;
    this.wasmPrefetched = true;

    try {
      // Sizes come from these two small files rather than Content-Length: a
      // host that compresses on the fly reports the compressed size while the
      // reader yields decompressed bytes, which would make the bar wrong
      // everywhere it matters.
      const [engine, manifest] = await Promise.all([
        fetch(ENGINE_DIR + "engine.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(TEXLIVE_DIR + "manifest.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);

      const assets: { url: string; bytes: number }[] = [
        { url: WASM_URL, bytes: Number(engine?.bytes ?? 0) },
      ];
      if (manifest?.format?.name) {
        assets.push({
          url: `${TEXLIVE_DIR}files/${manifest.format.name}`,
          bytes: Number(manifest.format.bytes ?? 0),
        });
      }

      const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
      let loaded = 0;

      for (const asset of assets) {
        const res = await fetch(asset.url, { credentials: "same-origin" });
        if (!res.ok || !res.body) continue;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.byteLength;
          this.events.onProgress?.(Math.min(loaded, total), total);
        }
      }

      this.events.onProgress?.(total, total);
    } catch {
      // Prefetching is an optimisation. If it fails, the worker still fetches
      // everything itself — just without a progress bar.
    }
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL);
      this.worker = worker;

      const startupTimer = setTimeout(() => {
        reject(new Error("The LaTeX engine did not start within 60 seconds."));
      }, 60_000);

      worker.onmessage = (ev: MessageEvent) => {
        const data = ev.data as Record<string, unknown>;
        // The engine announces readiness once, from Emscripten's postRun, with
        // a bare {result:"ok"} and no `cmd`.
        if (data.cmd === undefined) {
          clearTimeout(startupTimer);
          worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e);
          this.post({ cmd: "settexliveurl", url: this.texliveEndpoint() });
          resolve();
          return;
        }
        this.onWorkerMessage(ev);
      };

      worker.onerror = (ev) => {
        clearTimeout(startupTimer);
        reject(new Error(ev.message || "The LaTeX engine failed to load."));
      };
    });
  }

  private texliveEndpoint(): string {
    const origin = typeof location !== "undefined" ? location.origin : "";
    return origin + TEXLIVE_DIR;
  }

  private onWorkerMessage(ev: MessageEvent) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(ev.data as Record<string, unknown>);
  }

  /**
   * `settexliveurl` and `setmainfile` only assign a variable in the worker and
   * send nothing back, so they must be posted rather than awaited.
   */
  private post(message: Record<string, unknown>) {
    this.worker?.postMessage(message);
  }

  private send(
    message: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Engine is not running."));
    if (this.pending) return Promise.reject(new Error("Engine is busy."));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      worker.postMessage(message);
    });
  }

  /**
   * Compile a document. Runs up to `maxPasses` pdftex passes, stopping as soon
   * as the log no longer asks to be rerun.
   */
  async compile(request: CompileRequest): Promise<CompileOutcome> {
    await this.load();

    const maxPasses = request.maxPasses ?? DEFAULT_MAX_PASSES;

    try {
      await this.send({ cmd: "writefile", url: "main.tex", src: request.source });
      for (const asset of request.assets ?? []) {
        await this.send({ cmd: "writefile", url: asset.name, src: asset.data });
      }
      this.post({ cmd: "setmainfile", url: "main.tex" });
    } catch (err) {
      return this.recoverFrom(err, 0);
    }

    let last: Record<string, unknown> | null = null;
    let passes = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
      this.events.onPass?.(pass, maxPasses);
      passes = pass;
      try {
        last = await this.send({ cmd: "compilelatex" }, COMPILE_TIMEOUT_MS);
      } catch (err) {
        return this.recoverFrom(err, passes);
      }

      const log = String(last.log ?? "");
      if (last.result !== "ok") {
        return { ok: false, pdf: null, log, passes };
      }
      if (!needsRerun(log)) break;
    }

    const log = String(last?.log ?? "");
    const buffer = last?.pdf as ArrayBuffer | undefined;
    if (!buffer) return { ok: false, pdf: null, log, passes };
    return { ok: true, pdf: new Uint8Array(buffer), log, passes };
  }

  /**
   * A hung or crashed worker cannot be reasoned with — throw it away and start
   * a fresh one so the next keystroke is not compiling into a dead engine.
   */
  private async recoverFrom(err: unknown, passes: number): Promise<CompileOutcome> {
    const timedOut = err instanceof Error && err.message === "timeout";
    this.terminate();
    if (!this.disposed) this.ready = this.bootstrap();
    return {
      ok: false,
      pdf: null,
      passes,
      timedOut,
      log: timedOut
        ? "! TeXPane error: compilation exceeded 30 seconds and was stopped.\n" +
          "This usually means the document contains a macro that never terminates."
        : `! TeXPane error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  private terminate() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }

  dispose() {
    this.disposed = true;
    this.terminate();
  }
}

export function needsRerun(log: string): boolean {
  return RERUN_PATTERNS.some((re) => re.test(log));
}

export type { TexError };
