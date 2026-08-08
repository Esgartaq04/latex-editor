"use client";

import { Component, type ReactNode } from "react";

/**
 * Keeps a failure in one pane from white-screening the whole app — losing the
 * editor because pdf.js choked on a malformed PDF would also lose the user's
 * unsaved keystrokes.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message !== null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            {this.props.label} stopped working: {this.state.message}
          </p>
          <button
            type="button"
            className="rounded px-3 py-1 text-sm"
            style={{ border: "1px solid var(--line)" }}
            onClick={() => this.setState({ message: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
