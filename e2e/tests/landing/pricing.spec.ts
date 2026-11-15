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

// Sign-up is open by default (NEXT_PUBLIC_SIGNUP_OPEN unset): every main button goes to the dashboard registration.
test("the plan buttons and the main call-to-actions go to the dashboard registration", async ({ page }) => {
  await page.goto("/harga")
  const plans = await page.getByRole("link", { name: /^Pilih / }).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
  expect(plans).toEqual(["/dashboard/register", "/dashboard/register"])

  await page.goto("/")
  const ctas = await page.getByRole("link", { name: "Daftar dan pilih paket" }).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
  expect(ctas.length).toBeGreaterThan(0)
  expect(new Set(ctas)).toEqual(new Set(["/dashboard/register"]))
  await expect(page.locator('a[href*="subject="]')).toHaveCount(0)
})
