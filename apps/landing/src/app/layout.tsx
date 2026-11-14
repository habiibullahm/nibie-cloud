import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Onest } from "next/font/google"
import { SiteHeader } from "@/components/site/site-header"
import { SiteFooter } from "@/components/site/site-footer"
import { SITE } from "@/lib/site"
import "./globals.css"

// typography.h1 / display / h2 / label-caps
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
})

// typography.body-md / lead
const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
})

const DESCRIPTION =
  "Hosting terkelola untuk agent AI Hermes. Satu container terisolasi dan satu volume untuk setiap pelanggan, tanpa VPS dan tanpa perawatan. Harga dalam Rupiah."

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name}: hosting agent AI Hermes`, template: `%s · ${SITE.name}` },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "id_ID",
    siteName: SITE.name,
    title: `${SITE.name}: hosting agent AI Hermes`,
    description: DESCRIPTION,
    url: SITE.url,
  },
}

export const viewport: Viewport = {
  themeColor: "#0B0D0F", // colors.neutral
  colorScheme: "dark",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={`${bricolage.variable} ${onest.variable}`}>
      <body>
        <a
          href="#konten"
          className="sr-only rounded-sm bg-elevated px-4 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
        >
          Lewati ke konten
        </a>
        <SiteHeader />
        <main id="konten">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
