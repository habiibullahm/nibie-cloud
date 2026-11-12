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

// typography.body-md
const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
})

export const metadata: Metadata = {
  title: { default: "Dokumentasi Nibie Cloud", template: "%s · Nibie Cloud Docs" },
  description:
    "Panduan menjalankan agen AI Hermes di Nibie Cloud: deploy, kelola instance, dan referensi API.",
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
