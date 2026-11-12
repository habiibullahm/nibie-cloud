import type { NextConfig } from "next"
import { createMDX } from "fumadocs-mdx/next"

// Served at cloud.nibie.app/docs, so every route and asset lives under /docs.
// `output: "export"` produces static files only (no Node server); host them on Cloudflare.
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/docs",
  trailingSlash: false,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
}

const withMDX = createMDX()

export default withMDX(nextConfig)
