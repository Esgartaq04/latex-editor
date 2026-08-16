import type { NextConfig } from "next";

/**
 * TeXPane builds to a fully static site.
 *
 * Compilation happens in the visitor's browser (WebAssembly), and the TeX Live
 * files the engine needs are plain static assets. That means there is no
 * serverless function anywhere in the deployment, which is what keeps hosting
 * free: Vercel Hobby and Cloudflare Pages both serve static output at no cost.
 *
 * Cache headers live in `vercel.json` and `public/_headers` instead of here,
 * because `headers()` is not applied to a static export.
 */
// Set to "/<repo>" when deploying to a GitHub Pages project site; left empty
// for a root deployment. Read by lib/basePath.ts for asset URLs too.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
