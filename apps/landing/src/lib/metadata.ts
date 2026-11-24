import type { Metadata } from "next"
import { SITE } from "@/lib/site"

export const DEFAULT_TITLE = `${SITE.name} — Hosting Agent AI Hermes, Tanpa Urus Server`
export const DEFAULT_DESCRIPTION =
  "Satu container terisolasi & volume khusus per pelanggan, paket berbayar di Jakarta. Tinggal deploy, hubungkan Telegram, tanpa VPS. Harga dalam Rupiah."

export const OG_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Nibie Cloud — Hosting agent AI Hermes. Satu container terisolasi dan satu volume penyimpanan per pelanggan.",
} as const

export function pageMetadata(options: {
  title: string
  description: string
  path?: string
  index?: boolean
}): Metadata {
  const fullTitle = `${options.title} · ${SITE.name}`
  return {
    title: options.title,
    description: options.description,
    ...(options.path ? { alternates: { canonical: options.path } } : {}),
    ...(options.index === false ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      type: "website",
      locale: "id_ID",
      siteName: SITE.name,
      title: fullTitle,
      description: options.description,
      ...(options.path ? { url: options.path } : {}),
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: options.description,
      images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
    },
  }
}
