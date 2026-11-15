import { expect, test } from "@playwright/test"
import { expectNoSeriousViolations } from "../../support/a11y"
import { BASE } from "./helpers"

/**
 * The admin panel in T0 runs without a backend (`NEXT_PUBLIC_HERMES_API_MODE=mock`), so every admin
 * route must say so instead of drawing invented customers. That refusal is the behaviour under test:
 * a mock-mode admin screen showing sample data would be worse than an empty one.
 */
const ADMIN_PATHS = [
  "/admin",
  "/admin/pelanggan",
  "/admin/instance",
  "/admin/langganan",
  "/admin/plan",
  "/admin/node",
  "/admin/job",
  "/admin/audit",
]

for (const path of ADMIN_PATHS) {
  test(`${path} asks for a backend instead of showing sample data`, async ({ page }) => {
    await page.goto(`${BASE}${path}`)
    await expect(page.getByRole("heading", { name: "Panel admin butuh backend" })).toBeVisible()
    // No admin navigation, and no invented row, is rendered in this mode.
    await expect(page.getByRole("navigation", { name: "Navigasi admin" })).toHaveCount(0)
    await expect(page.getByRole("table")).toHaveCount(0)
  })
}

test("the admin link is hidden for a non-admin", async ({ page }) => {
  await page.goto(`${BASE}/instances`)
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0)
})

test("the admin panel has no serious accessibility violations", async ({ page }) => {
  await page.goto(`${BASE}/admin`)
  await expectNoSeriousViolations(page)
})
