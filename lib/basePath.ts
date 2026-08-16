/**
 * Path prefix the site is served under.
 *
 * Empty for a root deployment (Vercel, Cloudflare Pages, a custom domain).
 * A GitHub Pages *project* site is served from `/<repo>/`, so everything the
 * app fetches by absolute path — the WASM engine, the TeX Live store, the
 * pdf.js worker — has to carry that prefix.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time, which is why this
 * is a build-time value rather than something sniffed at runtime: the engine
 * and the worker need it before any React code runs.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

export function asset(path: string): string {
  return BASE_PATH + path;
}
