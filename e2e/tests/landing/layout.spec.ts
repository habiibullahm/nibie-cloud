import { expect, test } from "@playwright/test"

// Runs in the desktop (`landing`) and the 412 px phone (`landing-mobile`) projects.
for (const path of ["/", "/harga", "/kontak", "/syarat-layanan"]) {
  test(`${path} has no horizontal overflow`, async ({ page }) => {
    await page.goto(path)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}
