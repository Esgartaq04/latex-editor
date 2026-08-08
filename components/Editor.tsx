"use client";

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, StreamLanguage, indentUnit } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { oneDark } from "@codemirror/theme-one-dark";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { useEditorStore } from "@/lib/store/editorStore";

/**
 * CodeMirror is mounted imperatively and never re-created by React: rebuilding
 * the EditorView on render would drop the cursor, selection and undo history on
 * every keystroke.
 */
export function Editor({ theme }: { theme: "dark" | "light" }) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  const source = useEditorStore((s) => s.source);
  const errors = useEditorStore((s) => s.errors);
  const restored = useEditorStore((s) => s.restored);
  const setSource = useEditorStore((s) => s.setSource);
  const requestCompile = useEditorStore((s) => s.requestCompile);

  // Mount once. `theme` is in the dep list because the colour extensions are
  // static; a theme change is rare enough that a rebuild is acceptable.
  useEffect(() => {
    if (!host.current) return;

    const extensions = [
      lineNumbers(),
      history(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      lintGutter(),
      indentUnit.of("  "),
      StreamLanguage.define(stex),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            requestCompile();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          setSource(update.state.doc.toString());
        }
      }),
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--ink)" },
        ".cm-gutters": {
          backgroundColor: "var(--surface)",
          color: "var(--ink-dim)",
          border: "none",
        },
        ".cm-activeLineGutter": { backgroundColor: "var(--surface-raised)" },
        ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--ink) 4%, transparent)" },
      }),
    ];

    if (theme === "dark") extensions.push(oneDark);

    const state = EditorState.create({
      doc: useEditorStore.getState().source,
      extensions,
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [theme, setSource, requestCompile]);

  // Push external replacements (restore from IndexedDB, template picker) into
  // the view without echoing them back through `setSource`.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === source) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: source },
    });
  }, [source, restored]);

  // "line 42" in the error panel scrolls the editor there and puts the cursor
  // on it. Routed through a window event so the panel does not need a ref into
  // the EditorView.
  useEffect(() => {
    const onGoTo = (event: Event) => {
      const instance = view.current;
      const lineNumber = (event as CustomEvent<number>).detail;
      if (!instance || !lineNumber) return;
      if (lineNumber < 1 || lineNumber > instance.state.doc.lines) return;
      const line = instance.state.doc.line(lineNumber);
      instance.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
      instance.focus();
    };
    window.addEventListener("texpane:goto-line", onGoTo);
    return () => window.removeEventListener("texpane:goto-line", onGoTo);
  }, []);

  // Surface compiler diagnostics inline, next to the offending line.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const doc = instance.state.doc;
    const diagnostics: Diagnostic[] = [];

    for (const error of errors) {
      if (!error.line || error.line < 1 || error.line > doc.lines) continue;
      const line = doc.line(error.line);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: error.severity,
        message: error.message,
      });
    }

    instance.dispatch(setDiagnostics(instance.state, diagnostics));
  }, [errors]);

  return <div ref={host} className="h-full w-full overflow-hidden" data-testid="editor" />;
}
