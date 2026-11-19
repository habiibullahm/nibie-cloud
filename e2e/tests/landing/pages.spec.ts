import { expect, test } from "@playwright/test"

// Public pages that a payment provider's merchant review reads: they must always open and carry the right title.
const PAGES: Array<{ path: string; title: RegExp; heading: RegExp }> = [
  { path: "/", title: /^Nibie Cloud: hosting agent AI Hermes$/, heading: /Agent Hermes-mu aktif 24 jam/ },
  { path: "/harga", title: /^Harga · Nibie Cloud$/, heading: /^Harga$/ },
  { path: "/kontak", title: /^Kontak · Nibie Cloud$/, heading: /^Kontak$/ },
  { path: "/syarat-layanan", title: /^Syarat Layanan · Nibie Cloud$/, heading: /^Syarat Layanan$/ },
  { path: "/kebijakan-refund", title: /^Kebijakan Refund · Nibie Cloud$/, heading: /^Kebijakan Refund$/ },
  { path: "/kebijakan-privasi", title: /^Kebijakan Privasi · Nibie Cloud$/, heading: /^Kebijakan Privasi$/ },
]

for (const p of PAGES) {
  test(`${p.path} opens with the right title and heading, without console errors`, async ({ page }) => {
    const errors: string[] = []
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    page.on("pageerror", (e) => errors.push(e.message))
    const res = await page.goto(p.path)
    expect(res?.status()).toBe(200)
    await expect(page).toHaveTitle(p.title)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.heading)
    expect(errors).toEqual([])
  })
}

test("an unknown path answers 404 with the friendly page", async ({ page }) => {
  const res = await page.goto("/halaman-yang-tidak-ada")
  expect(res?.status()).toBe(404)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Halaman tidak ditemukan")
})

test("robots.txt and sitemap.xml answer 200", async ({ request }) => {
  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    expect((await request.get(path)).status(), path).toBe(200)
  }
})

test("the header and footer link to the legal pages and to sign-in", async ({ page }) => {
  await page.goto("/")
  const footer = page.getByRole("contentinfo")
  for (const name of ["Syarat Layanan", "Kebijakan Refund", "Kebijakan Privasi", "Kontak"]) {
    await expect(footer.getByRole("link", { name })).toBeVisible()
  }
  await expect(page.getByRole("banner").getByRole("link", { name: "Masuk" })).toHaveAttribute("href", "/dashboard/sign-in")
})
