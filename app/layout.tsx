import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TeXPane — LaTeX in your browser",
  description:
    "A LaTeX editor with a live PDF preview. A real TeX engine runs in your browser, so nothing is uploaded and there is nothing to install.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

/** Applied before paint so a light-theme user never sees a dark flash. */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem("texpane-theme");
  if (t === "light" || (!t && window.matchMedia("(prefers-color-scheme: light)").matches)) {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
