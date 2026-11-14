import type { NextConfig } from "next"

/**
 * Public landing page for https://cloud.nibie.app (root). The dashboard lives under /dashboard and the
 * docs under /docs, each in its own package and Worker. Static export only: no Node server, no
 * server-side secrets. Host the `out/` directory as Worker static assets (see wrangler.jsonc).
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: false,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
}

export default nextConfig
