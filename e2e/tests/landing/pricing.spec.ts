import { expect, test } from "@playwright/test"

// Prices are written out on purpose: a typo in apps/landing/src/lib/plans.ts must fail here.
test("the pricing page shows all four plans with normal and beta prices", async ({ page }) => {
  await page.goto("/harga")
  for (const price of ["Rp 25.000", "Rp 50.000", "Rp 75.000", "Rp 49.000", "Rp 79.000", "Rp 119.000"]) {
    await expect(page.getByText(price).first()).toBeVisible()
  }
  await expect(page.getByText(/Beta · diskon 50\s?%/)).toBeVisible()
  await expect(page.getByText(/Beta · diskon 33\s?%/)).toBeVisible()
  await expect(page.getByText(/Beta · diskon 38\s?%/)).toBeVisible()
  await expect(page.getByText(/Beta · diskon 34\s?%/)).toBeVisible()
  await expect(page.getByText("$2 setiap bulan")).toBeVisible()
  await expect(page.getByText("$3 setiap bulan")).toBeVisible()
  await expect(page.getByText("tidak termasuk", { exact: true })).toHaveCount(2)
})

// Sign-up is open by default (NEXT_PUBLIC_SIGNUP_OPEN unset): every main button goes to the dashboard registration.
test("the plan buttons and the main call-to-actions go to the dashboard registration", async ({ page }) => {
  await page.goto("/harga")
  const plans = await page.getByRole("link", { name: /^Pilih / }).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
  expect(plans).toEqual(Array(4).fill("/dashboard/register"))

  await page.goto("/")
  const ctas = await page.getByRole("link", { name: "Daftar dan pilih paket" }).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
  expect(ctas.length).toBeGreaterThan(0)
  expect(new Set(ctas)).toEqual(new Set(["/dashboard/register"]))
  await expect(page.locator('a[href*="subject="]')).toHaveCount(0)
})
