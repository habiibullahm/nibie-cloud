import Image from "next/image"
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"
import logoMark from "@/assets/logo-mark-on-dark.png"

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // The mark is decorative: the text beside it already names the site.
      title: (
        <>
          <Image src={logoMark} alt="" width={30} height={20} priority />
          Nibie Cloud Docs
        </>
      ),
      url: "/",
    },
    themeSwitch: { enabled: false },
    links: [{ text: "Dashboard", url: "https://cloud.nibie.app/dashboard", external: true }],
  }
}
