import { expect, test } from "@playwright/test"
import { BASE, status } from "./helpers"

test("the list shows the three seeded instances with a text status each", async ({ page }) => {
  await page.goto(`${BASE}/instances`)
  const list = page.getByRole("list", { name: "Your instances" })
  await expect(list.getByRole("listitem")).toHaveCount(3)
  for (const [name, label] of [["weekend-sandbox", "Stopped"], ["atlas-assistant", "Active"], ["research-bot", "Degraded"]] as const) {
    const card = list.getByRole("listitem").filter({ hasText: name })
    await expect(card).toBeVisible()
    await expect(status(card, label)).toBeVisible()
  }
})

test("mock data is labelled as preview data", async ({ page }) => {
  await page.goto(`${BASE}/instances`)
  await expect(page.getByText("Preview data").first()).toBeVisible()
})

test("?empty shows the empty state with a way to deploy", async ({ page }) => {
  await page.goto(`${BASE}/instances?empty`)
  await expect(page.getByText("No instances yet")).toBeVisible()
  await page.getByRole("link", { name: "Deploy your first instance" }).click()
  await expect(page).toHaveURL(/\/dashboard\/deploy$/)
})

test("?fail shows an error with a retry instead of a blank page", async ({ page }) => {
  await page.goto(`${BASE}/instances`)
  const atlas = page.getByRole("listitem").filter({ hasText: "atlas-assistant" })
  const href = await atlas.getByRole("link", { name: "atlas-assistant" }).getAttribute("href")
  await page.goto(`${href}/monitor?fail`)
  const alert = page.getByRole("alert").filter({ hasText: /^Could not load/ })
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible()
})

test("an unknown route shows the not-found page", async ({ page }) => {
  const res = await page.goto(`${BASE}/dit-bestaat-niet`)
  expect(res?.status()).toBe(404)
})
