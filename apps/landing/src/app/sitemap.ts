import type { MetadataRoute } from "next"
import { SITE } from "@/lib/site"

export const dynamic = "force-static"

const PATHS = ["", "/harga", "/kontak", "/syarat-layanan", "/kebijakan-refund", "/kebijakan-privasi"]

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${SITE.url}${p}` }))
}
