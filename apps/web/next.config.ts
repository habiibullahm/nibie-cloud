import type { NextConfig } from "next"

/** The dashboard is served at https://cloud.nibie.app/dashboard; the root belongs to the landing page. */
const BASE_PATH = "/dashboard"

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // fetch() does not add the base path by itself; client code reads it from here.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  poweredByHeader: false,
  reactStrictMode: true,
}

export default nextConfig
