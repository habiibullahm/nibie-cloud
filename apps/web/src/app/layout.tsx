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

export const metadata: Metadata = {
  title: { default: "Nibie Cloud", template: "%s · Nibie Cloud" },
  description: "Your own AI agent in the cloud. No server to set up or maintain.",
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
