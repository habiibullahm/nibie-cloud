import type { NextConfig } from "next"

/** The dashboard is served at https://cloud.nibie.app/dashboard; the root belongs to the landing page. */
const BASE_PATH = "/dashboard"

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // fetch() does not add the base path by itself; client code reads it from here.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  poweredByHeader: false,
  reactStrictMode: true,
  // No framing, no full URLs in Referer, no device APIs. A full Content-Security-Policy needs the Supabase and API origins
  // and is left for a separate change. `source` is prefixed with basePath automatically.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]
  },
}

export default nextConfig
