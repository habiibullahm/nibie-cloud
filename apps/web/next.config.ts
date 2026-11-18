import type { NextConfig } from "next"
import { dashboardCsp } from "./src/lib/csp"

/** The dashboard is served at https://cloud.nibie.app/dashboard; the root belongs to the landing page. */
const BASE_PATH = "/dashboard"

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // fetch() does not add the base path by itself; client code reads it from here.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  poweredByHeader: false,
  reactStrictMode: true,
  // CSP from the public build variables (see src/lib/csp.ts), no framing, no full URLs in Referer, no device APIs.
  // `source` is prefixed with basePath automatically.
  async headers() {
    const csp = dashboardCsp({
      apiUrl: process.env.NEXT_PUBLIC_HERMES_API_URL,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      dev: process.env.NODE_ENV === "development",
    })
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]
  },
}

export default nextConfig
