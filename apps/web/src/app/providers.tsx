"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { useTheme } from "@/lib/prefs"

export function Providers({ children }: { children: React.ReactNode }) {
  // The browser bar follows the in-app theme: <meta name="theme-color"> takes the page background token (--hc-neutral).
  const theme = useTheme()
  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--hc-neutral").trim()
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color)
  }, [theme])
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
        },
      })
  )
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  )
}
