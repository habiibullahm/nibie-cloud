import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Onest } from "next/font/google"
import { RootProvider } from "fumadocs-ui/provider/next"
import "./global.css"

// typography.h1 / typography.label-caps
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
})

// typography.body-md; 600 so bold text in prose uses the real face instead of a synthetic bold.
const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
})

const DESCRIPTION =
  "Panduan menjalankan agen AI Hermes di Nibie Cloud: deploy, kelola instance, dan referensi API."
const OG_IMAGE = {
  url: "/docs/og-image.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Dokumentasi Nibie Cloud — Panduan deploy dan kelola agent AI Hermes.",
} as const

export const metadata: Metadata = {
  metadataBase: new URL("https://cloud.nibie.app"),
  title: { default: "Dokumentasi Nibie Cloud", template: "%s · Nibie Cloud Docs" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    locale: "id_ID",
    siteName: "Nibie Cloud Docs",
    title: "Dokumentasi Nibie Cloud",
    description: DESCRIPTION,
    url: "/docs",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "Dokumentasi Nibie Cloud",
    description: DESCRIPTION,
    images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
  },
}

export const viewport: Viewport = {
  themeColor: "#0B0D0F", // colors.neutral
  colorScheme: "dark",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={`dark ${bricolage.variable} ${onest.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          theme={{ enabled: false, forcedTheme: "dark", defaultTheme: "dark" }}
          i18n={{
            locale: "id",
            translations: {
              "On this page(table of contents)": "Di halaman ini",
              "No Headings(table of contents)": "Tidak ada judul",
              "No results found(search dialog)": "Tidak ada hasil",
              "Next Page(pagination)": "Berikutnya",
              "Previous Page(pagination)": "Sebelumnya",
              "Search(search dialog)": "Cari",
              "Search(search trigger)": "Cari",
            },
          }}
          search={{ options: { type: "static", api: "/docs/api/search" } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
