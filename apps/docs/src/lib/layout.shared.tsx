import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Nibie Cloud Docs",
      url: "/",
    },
    themeSwitch: { enabled: false },
    links: [{ text: "Dashboard", url: "https://cloud.nibie.app/dashboard", external: true }],
  }
}
