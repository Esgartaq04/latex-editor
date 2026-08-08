import { describe, expect, it } from "vitest";
import { parseTexLog, summarise } from "@/lib/parseTexLog";
import { deriveBasename } from "@/lib/export/download";
import { needsRerun } from "@/lib/compiler/engine";

describe("parseTexLog", () => {
  it("pulls the line number out of TeX's own l.<n> marker", () => {
    const log = [
      "(/tex/article.cls)",
      "! Undefined control sequence.",
      "l.4 \\undefinedmacro",
      "                   ",
      "? ",
    ].join("\n");

    const [error] = parseTexLog(log);
    expect(error.severity).toBe("error");
    expect(error.line).toBe(4);
    expect(error.message).toBe("Undefined control sequence.");
    expect(error.detail).toContain("\\undefinedmacro");
  });

  it("falls back to 'on input line N' when there is no l.<n>", () => {
    const log = "! LaTeX Error: \\begin{itemize} on input line 12 ended by \\end{document}.";
    const [error] = parseTexLog(log);
    expect(error.line).toBe(12);
  });

  it("reads the file:line: form", () => {
    const [error] = parseTexLog("./main.tex:31: Missing $ inserted");
    expect(error.line).toBe(31);
    expect(error.message).toBe("Missing $ inserted");
  });

  it("classifies warnings separately from errors", () => {
    const log = [
      "LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 30.",
      "! Undefined control sequence.",
      "l.9 \\nope",
    ].join("\n");

    const parsed = parseTexLog(log);
    expect(parsed.filter((e) => e.severity === "warning")).toHaveLength(1);
    expect(parsed.filter((e) => e.severity === "error")).toHaveLength(1);
    expect(parsed.find((e) => e.severity === "warning")?.line).toBe(30);
  });

  it("returns nothing for a clean log", () => {
    expect(parseTexLog("This is pdfTeX\nOutput written on main.pdf (1 page).")).toEqual([]);
  });

  it("drops duplicates so one error is not listed per pass", () => {
    const single = "! Undefined control sequence.\nl.4 \\nope";
    expect(parseTexLog(`${single}\n${single}`)).toHaveLength(1);
  });

  it("does not invent a line number it cannot find", () => {
    const [error] = parseTexLog("! Emergency stop.");
    expect(error.line).toBeNull();
  });

  it("summarises the first hard error ahead of warnings", () => {
    const log = [
      "LaTeX Warning: Something minor on input line 2.",
      "! Undefined control sequence.",
      "l.9 \\nope",
    ].join("\n");
    expect(summarise(parseTexLog(log))).toBe("Line 9: Undefined control sequence.");
  });
});

describe("needsRerun", () => {
  it("detects the cross-reference rerun request", () => {
    expect(needsRerun("LaTeX Warning: Label(s) may have changed. Rerun to get")).toBe(true);
    expect(needsRerun("Rerun to get cross-references right.")).toBe(true);
  });

  it("does not rerun a clean compile", () => {
    expect(needsRerun("Output written on main.pdf (2 pages, 1234 bytes).")).toBe(false);
  });
});

describe("deriveBasename", () => {
  it("slugifies \\title", () => {
    expect(deriveBasename("\\title{A Study of Widgets}")).toBe("a-study-of-widgets");
  });

  it("strips markup inside the title", () => {
    expect(deriveBasename("\\title{The \\LaTeX{} Companion}")).toBe("the-companion");
  });

  it("falls back when there is no title", () => {
    expect(deriveBasename("\\documentclass{article}")).toBe("document");
  });

  it("falls back when the title has no usable characters", () => {
    expect(deriveBasename("\\title{$$}")).toBe("document");
  });
});
