import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Onest } from "next/font/google"
import { DEFAULT_LANG, DEFAULT_THEME, PREFS_SCRIPT } from "@/lib/prefs-core"
import { Providers } from "./providers"
import "./globals.css"

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

const DESCRIPTION = "Your own AI agent in the cloud. No server to set up or maintain."
const OG_IMAGE = {
  url: "/dashboard/og-image.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Nibie Cloud — Managed hosting for Hermes AI agents.",
} as const

export const metadata: Metadata = {
  metadataBase: new URL("https://cloud.nibie.app"),
  title: { default: "Nibie Cloud", template: "%s · Nibie Cloud" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Nibie Cloud",
    title: "Nibie Cloud",
    description: DESCRIPTION,
    url: "/dashboard",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "Nibie Cloud",
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
    // PREFS_SCRIPT rewrites lang and data-theme before paint from the viewer's saved choice, hence suppressHydrationWarning.
    <html lang={DEFAULT_LANG} data-theme={DEFAULT_THEME} className={`${bricolage.variable} ${onest.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREFS_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
