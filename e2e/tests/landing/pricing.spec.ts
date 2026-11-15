import { expect, test } from "@playwright/test"

// Prices are written out on purpose: a typo in apps/landing/src/lib/plans.ts must fail here.
test("the pricing page shows both plans with normal and beta prices", async ({ page }) => {
  await page.goto("/harga")
  await expect(page.getByText("Rp 25.000").first()).toBeVisible()
  await expect(page.getByText("Rp 50.000").first()).toBeVisible()
  await expect(page.getByText("Rp 75.000").first()).toBeVisible()
  await expect(page.getByText(/Beta · diskon 50\s?%/)).toBeVisible()
  await expect(page.getByText(/Beta · diskon 33\s?%/)).toBeVisible()
  await expect(page.getByText("$2, sekali di awal")).toBeVisible()
  await expect(page.getByText("tidak termasuk", { exact: true })).toBeVisible()
})

test("the request-access buttons open the mail client for the right plan", async ({ page }) => {
  await page.goto("/harga")
  const hrefs = await page.getByRole("link", { name: /^Pilih / }).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
  expect(hrefs).toHaveLength(2)
  expect(decodeURIComponent(hrefs[0]!)).toContain("paket Hosting")
  expect(decodeURIComponent(hrefs[1]!)).toContain("paket Hosting + Kredit AI")
})
