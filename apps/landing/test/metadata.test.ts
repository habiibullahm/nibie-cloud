import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_DESCRIPTION, DEFAULT_TITLE, OG_IMAGE, pageMetadata } from "@/lib/metadata"

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("landing metadata", () => {
  it("keeps default title and description within social preview lengths", () => {
    expect(DEFAULT_TITLE.length).toBeGreaterThan(20)
    expect(DEFAULT_TITLE.length).toBeLessThanOrEqual(65)
    expect(DEFAULT_DESCRIPTION.length).toBeGreaterThan(80)
    expect(DEFAULT_DESCRIPTION.length).toBeLessThanOrEqual(160)
  })

  it("builds complete Open Graph and Twitter card metadata with the image for subpages", () => {
    const meta = pageMetadata({
      title: "Harga",
      description: "Harga langganan bulanan Nibie Cloud dalam Rupiah.",
      path: "/harga",
    })
    expect(meta.title).toBe("Harga")
    expect(meta.alternates).toEqual({ canonical: "/harga" })
    expect(meta.openGraph).toMatchObject({
      type: "website",
      locale: "id_ID",
      siteName: "Nibie Cloud",
      title: "Harga · Nibie Cloud",
      description: "Harga langganan bulanan Nibie Cloud dalam Rupiah.",
      url: "/harga",
      images: [OG_IMAGE],
    })
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Harga · Nibie Cloud",
      description: "Harga langganan bulanan Nibie Cloud dalam Rupiah.",
      images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
    })
  })

  it("supports noindex routes without leaking canonical", () => {
    const meta = pageMetadata({
      title: "Konfirmasi",
      description: "Konfirmasi email.",
      index: false,
    })
    expect(meta.robots).toEqual({ index: false, follow: false })
    expect(meta.alternates).toBeUndefined()
  })

  it("ships a 1200x630 PNG Open Graph image in public/", () => {
    const png = readFileSync(join(__dirname, "..", "public", "og-image.png"))
    expect(png.subarray(0, 8)).toEqual(PNG_SIG)
    // IHDR chunk starts at byte 12 ("IHDR"), width at 16..19, height at 20..23 (big-endian uint32).
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR")
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.length).toBeLessThan(1_000_000)
    expect(OG_IMAGE.alt.length).toBeGreaterThan(20)
    expect(OG_IMAGE.alt).not.toContain("\n")
  })
})
