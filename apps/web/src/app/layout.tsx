import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Onest } from "next/font/google"
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
  title: { default: "Hermes Cloud", template: "%s · Hermes Cloud" },
  description: "Run your personal AI agent 24/7. No VPS, no setup, no infrastructure maintenance.",
}

export const viewport: Viewport = {
  themeColor: "#0B0D0F", // colors.neutral
  colorScheme: "dark",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${bricolage.variable} ${onest.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
