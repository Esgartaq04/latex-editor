import type { TexError } from "./compiler/types";

/**
 * Turn a pdftex log into something a person can act on.
 *
 * The log is not structured, so this is pattern matching, and it errs towards
 * dropping a diagnostic rather than inventing a wrong line number — an error
 * pointing at the wrong line is worse than one with no line at all.
 *
 * Recognised shapes:
 *
 *   ! LaTeX Error: \begin{itemize} on input line 12 ended by \end{document}.
 *   ! Undefined control sequence.
 *   l.42 \bogus
 *   ! Package hyperref Error: ...
 *   LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 30.
 *   ./main.tex:12: Undefined control sequence
 */

const MAX_DIAGNOSTICS = 100;

/** `l.42 \foo` — TeX's own "this is where I was" marker. */
const LINE_MARKER = /^l\.(\d+)\s?(.*)$/;
/** `... on input line 42.` */
const INPUT_LINE = /on input line (\d+)/;
/** `./main.tex:42: message` — file:line:message form. */
const FILE_LINE = /^(?:\.\/)?[^\s:]+\.(?:tex|sty|cls|ltx):(\d+):\s*(.*)$/;
/** ``LaTeX Error: File `charter.sty' not found.`` */
const MISSING_FILE = /(?:LaTeX Error: )?File [`'"]([^`'"]+)['"] not found/;

/**
 * @param source the document, used to point missing-file errors at the line
 *   that asked for the package rather than wherever TeX happened to give up.
 */
export function parseTexLog(log: string, source?: string): TexError[] {
  const lines = log.split(/\r?\n/);
  const out: TexError[] = [];

  for (let i = 0; i < lines.length && out.length < MAX_DIAGNOSTICS; i++) {
    const line = lines[i];

    if (line.startsWith("!")) {
      const message = cleanMessage(line.slice(1));
      const { detail, lineNumber } = collectContext(lines, i + 1);

      const missing = MISSING_FILE.exec(message);
      if (missing) {
        // TeX stops at an interactive prompt and then reports whatever line it
        // was reading when it gave up — usually the *next* \usepackage. Blaming
        // that line sends people to edit something that is not the problem.
        const file = missing[1];
        out.push({
          line: findRequestingLine(source, file),
          message: describeMissingFile(file),
          detail,
          severity: "error",
        });
        continue;
      }

      out.push({
        line: lineNumber ?? matchInputLine(message),
        message: message || "TeX error",
        detail,
        severity: "error",
      });
      continue;
    }

    const fileLine = FILE_LINE.exec(line);
    if (fileLine) {
      out.push({
        line: Number(fileLine[1]),
        message: cleanMessage(fileLine[2]) || "TeX error",
        severity: "error",
      });
      continue;
    }

    if (/^(LaTeX|Package|Class)\b.*\bWarning:/.test(line)) {
      // Warnings wrap; pull in the continuation so `on input line N` is not lost.
      let text = line;
      let j = i + 1;
      while (j < lines.length && /^\(\w|^\s{2,}\S/.test(lines[j]) && j - i < 4) {
        text += " " + lines[j].trim();
        j++;
      }
      out.push({
        line: matchInputLine(text),
        message: cleanMessage(text),
        severity: "warning",
      });
    }
  }

  return dedupe(out);
}

/**
 * After a `!` line TeX prints the offending context, ending in `l.<n>`.
 * Everything up to that point is the detail worth showing.
 */
function collectContext(
  lines: string[],
  start: number,
): { detail: string; lineNumber: number | null } {
  const detail: string[] = [];
  for (let i = start; i < lines.length && i < start + 12; i++) {
    const marker = LINE_MARKER.exec(lines[i]);
    if (marker) {
      detail.push(lines[i]);
      // The continuation line shows the rest of the input line.
      if (lines[i + 1] !== undefined && !lines[i + 1].startsWith("!")) {
        detail.push(lines[i + 1]);
      }
      return { detail: detail.join("\n").trim(), lineNumber: Number(marker[1]) };
    }
    if (lines[i].startsWith("!")) break;
    if (lines[i].trim()) detail.push(lines[i]);
  }
  return { detail: detail.join("\n").trim(), lineNumber: null };
}

/**
 * A missing file is almost never a mistake in the document — it is a package
 * this build does not carry. Say that, rather than repeating TeX's phrasing and
 * leaving the reader to wonder what they typed wrong.
 */
function describeMissingFile(file: string): string {
  const name = file.replace(/\.(sty|cls|def|cfg|clo|fd)$/, "");
  const kind = file.endsWith(".cls") ? "document class" : "package";
  return (
    `The ${kind} "${name}" is not in this editor's TeX Live bundle, so the ` +
    `document cannot be typeset. Remove it, or open an issue to have it added.`
  );
}

/**
 * Find where the document asked for a package. Matches `\usepackage{a,b}`,
 * `\RequirePackage`, and `\documentclass`, so the reported line is the one
 * worth editing.
 */
function findRequestingLine(source: string | undefined, file: string): number | null {
  if (!source) return null;
  const name = file.replace(/\.(sty|cls|def|cfg|clo|fd)$/, "");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}`,
  );

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const requested = match[1].split(",").map((entry) => entry.trim());
    if (requested.some((entry) => new RegExp(`^${escaped}$`).test(entry))) return i + 1;
  }
  return null;
}

function matchInputLine(text: string): number | null {
  const m = INPUT_LINE.exec(text);
  return m ? Number(m[1]) : null;
}

function cleanMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dedupe(errors: TexError[]): TexError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.severity}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The one line to show in the status bar: the first hard error, or the first
 * warning if the document compiled.
 */
export function summarise(errors: TexError[]): string | null {
  const first = errors.find((e) => e.severity === "error") ?? errors[0];
  if (!first) return null;
  return first.line ? `Line ${first.line}: ${first.message}` : first.message;
}
